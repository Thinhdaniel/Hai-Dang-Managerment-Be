import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import DistributionRecord from '@/models/DistributionRecord';
import InventoryStock from '@/models/InventoryStock';
import StockTransaction from '@/models/StockTransaction';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import { distributionRepository } from '@/repositories/distribution.repository';
import { purchaseOrderRepository } from '@/repositories/purchase-order.repository';
import { purchaseRequestRepository } from '@/repositories/purchase-request.repository';
import {
    applyStockMovement,
    assertPlantAccess,
    ensurePlantExists,
    generateDocumentCode,
    getUserPlantId,
    isManagerRole,
    toId,
} from '@/services/material-workflow.helpers';
import { buildDistributionItems, getMaterialsMap } from '@/services/material-domain.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializeDistributionRecord } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildDistributionFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
    };

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [{ distributionCode: regex }, { note: regex }, { 'items.materialName': regex }];
    }

    if (query.status) {
        filter.status = query.status;
    }

    if (query.fromPlantId) {
        filter.fromPlantId = query.fromPlantId;
    }

    if (query.toPlantId) {
        filter.toPlantId = query.toPlantId;
    }

    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) {
            filter.createdAt.$gte = new Date(String(query.startDate));
        }
        if (query.endDate) {
            const endDate = new Date(String(query.endDate));
            endDate.setHours(23, 59, 59, 999);
            filter.createdAt.$lte = endDate;
        }
    }

    if (query.supplyRequestId) {
        filter.supplyRequestId = query.supplyRequestId;
    }

    if (!isManagerRole(req.role)) {
        const userPlantId = getUserPlantId(req);
        filter.$or = [{ fromPlantId: userPlantId }, { toPlantId: userPlantId }];
    }

    return filter;
};

const ensureDistributionAccess = (req: Request, distribution: any) => {
    if (isManagerRole(req.role)) {
        return;
    }

    const userPlantId = getUserPlantId(req);
    const fromPlantId = toId(distribution.fromPlantId);
    const toPlantId = toId(distribution.toPlantId);

    if (userPlantId !== fromPlantId && userPlantId !== toPlantId) {
        throw new UnAuthorizedError('Ban khong co quyen truy cap phieu cap phat nay');
    }
};

export const getAllDistributionRecords = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildDistributionFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || '-createdAt')
        .split(',')
        .join(' ');

    const [records, total] = await Promise.all([
        distributionRepository.findMany(filter, { sort, skip, limit }),
        distributionRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(records.map(serializeDistributionRecord), total, page, limit),
            message: 'Lay danh sach phieu cap phat thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getDistributionRecordById = async (req: Request, res: Response, next: NextFunction) => {
    const record = await distributionRepository.findById(String(req.params.id));

    if (!record) {
        throw new NotFoundError('Khong tim thay phieu cap phat');
    }

    ensureDistributionAccess(req, record);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeDistributionRecord(record),
            message: 'Lay chi tiet phieu cap phat thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createDistributionRecord = async (req: Request, res: Response, next: NextFunction) => {
    const { supplyRequestId, distributedAt, items, totalAmount, totalVat, totalWithVat, note } = req.body;

    // 1. Validate supply request
    const sr = await PurchaseRequest.findOne({
        _id: supplyRequestId,
        requestType: 'supply_request',
        isDeleted: { $ne: true },
    }).populate('fromPlantId');

    if (!sr) throw new NotFoundError('Khong tim thay phieu de xuat cap vat tu');
    if (sr.status !== 'approved') throw new BadRequestError('Chi tao phieu cap phat tu de xuat da duoc duyet');

    // 2. Kiểm tra chưa có distribution từ SR này
    const existing = await (DistributionRecord as any).findOne({
        supplyRequestId: sr._id,
        isDeleted: { $ne: true },
    });
    if (existing) throw new BadRequestError(`De xuat nay da co phieu cap phat: ${existing.distributionCode}`);

    // 3. Tạo distribution
    const distributionCode = await generateDocumentCode({
        model: DistributionRecord,
        field: 'distributionCode',
        prefix: 'CP',
    });

    const mainPlantId = process.env.MAIN_PLANT_ID;
    if (!mainPlantId) throw new BadRequestError('Chua cau hinh MAIN_PLANT_ID');

    const toPlantId = toId((sr as any).fromPlantId);
    if (!toPlantId) throw new BadRequestError('Phieu de xuat thieu thong tin co so gui');

    const builtItems = (items ?? []).map((item: any, idx: number) => {
        const qty = Number(item.quantity ?? 0);
        if (qty <= 0) throw new BadRequestError(`Item ${idx + 1}: so luong phai lon hon 0`);

        const price = Number(item.unitPrice ?? -1);
        if (price < 0) throw new BadRequestError(`Item ${idx + 1}: don gia bat buoc (>= 0)`);

        const vatRate = Number(item.vatRate ?? -1);
        if (vatRate < 0) throw new BadRequestError(`Item ${idx + 1}: VAT bat buoc (>= 0)`);

        // Recalculate — never trust FE
        const totalPrice = Number((qty * price).toFixed(2));
        const vatAmount = Number((totalPrice * vatRate / 100).toFixed(2));
        const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));

        return {
            materialId: item.materialId,
            materialName: item.materialName,
            unit: item.unit,
            quantityRequested: item.quantityRequested ?? qty,
            quantity: qty,
            unitPrice: price,
            totalPrice,
            vatRate,
            vatAmount,
            totalWithVat,
            adjustReason: item.adjustReason?.trim() || undefined,
            note: item.note?.trim() || undefined,
        };
    });

    const record = await distributionRepository.create({
        distributionCode,
        supplyRequestId: sr._id,
        fromPlantId: mainPlantId,
        toPlantId,
        status: 'pending',
        items: builtItems,
        totalAmount: totalAmount ?? 0,
        totalVatAmount: totalVat ?? 0,
        totalWithVat: totalWithVat ?? 0,
        distributedAt: distributedAt ? new Date(distributedAt) : undefined,
        note: note?.trim() || undefined,
    });

    // 4. Cập nhật SR status
    await PurchaseRequest.updateOne({ _id: sr._id }, { $set: { status: 'in_progress' } });

    const created = await distributionRepository.findById(String((record as any)._id));
    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeDistributionRecord(created),
            message: 'Tao phieu cap phat thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const distributeRecord = async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // FIX 2: Atomic lock — chỉ lấy được nếu status vẫn là 'pending'
        const record = await (DistributionRecord as any).findOneAndUpdate(
            { _id: req.params.id, status: 'pending', isDeleted: { $ne: true } },
            { $set: { status: 'processing' } },
            { new: false, session }
        );

        if (!record) {
            const exists = await (DistributionRecord as any).findById(req.params.id).session(session);
            if (!exists) throw new NotFoundError('Khong tim thay phieu cap phat');
            throw new BadRequestError('Phieu cap phat da duoc xu ly hoac dang duoc xu ly boi tien trinh khac');
        }

        const CS1_ID = new mongoose.Types.ObjectId(process.env.MAIN_PLANT_ID || '');

        for (const item of record.items ?? []) {
            const qty = Number(item.quantity ?? 0);
            if (qty <= 0 || !item.materialId) continue;

            const materialId = new mongoose.Types.ObjectId(String(item.materialId));

            const stock = await (InventoryStock as any)
                .findOne({ materialId, plantId: CS1_ID, isDeleted: { $ne: true } })
                .session(session);

            const stockBefore = Number(stock?.currentStock ?? 0);

            // FIX 1: Không cho phép xuất kho nếu không đủ tồn kho
            if (stockBefore < qty) {
                throw new BadRequestError(
                    `Ton kho CS1 khong du cho vat tu "${item.materialName || materialId}": can ${qty}, con ${stockBefore}`
                );
            }

            const stockAfter = stockBefore - qty;

            await (InventoryStock as any).updateOne(
                { _id: stock._id },
                { $set: { currentStock: stockAfter } },
                { session }
            );

            await StockTransaction.create([{
                type: 'export',
                materialId,
                materialName: item.materialName,
                plantId: CS1_ID,
                quantity: -qty,
                stockBefore,
                stockAfter,
                relatedId: record._id,
                relatedType: 'distribution',
                performedBy: req.userId,
                note: `Xuat kho cap phat ${record.distributionCode}`,
            }], { session });
        }

        await (DistributionRecord as any).updateOne(
            { _id: record._id },
            { $set: { status: 'distributed', distributedBy: req.userId, distributedAt: new Date() } },
            { session }
        );

        await session.commitTransaction();
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
    }

    const updated = await distributionRepository.findById(String(req.params.id));
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeDistributionRecord(updated),
            message: 'Xac nhan xuat kho thanh cong, ton kho CS1 da cap nhat',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const confirmDistributionRecord = async (req: Request, res: Response, next: NextFunction) => {
    // Raw query để tránh populate che khuất data thật
    const raw = await (DistributionRecord as any).findById(req.params.id).lean();
    console.log('[CONFIRM DEBUG] id=%s status=%s toPlantId=%s userPlantId=%s',
        req.params.id, raw?.status, String(raw?.toPlantId), String((req.user as any)?.plantId));

    const record = await distributionRepository.findById(String(req.params.id));
    if (!record) throw new NotFoundError('Khong tim thay phieu cap phat');

    ensureDistributionAccess(req, record);

    if ((record as any).status !== 'distributed') {
        throw new BadRequestError(`Khong the confirm khi status=${(record as any).status} (can: distributed)`);
    }

    // Chỉ CS nhận (toPlantId) mới được confirm — bỏ qua nếu là manager/admin
    if (!isManagerRole(req.role)) {
        const userPlantId = getUserPlantId(req);
        const toPlantId = toId((record as any).toPlantId);
        if (userPlantId !== toPlantId) {
            throw new UnAuthorizedError(`Sai co so: user=${userPlantId} toPlant=${toPlantId}`);
        }
    }

    await (DistributionRecord as any).updateOne(
        { _id: (record as any)._id },
        { $set: { status: 'confirmed', confirmedBy: req.userId, confirmedAt: new Date() } }
    );

    const supplyRequestId = toId((record as any).supplyRequestId);
    if (supplyRequestId) {
        await PurchaseRequest.updateOne(
            { _id: supplyRequestId },
            { $set: { status: 'distributed' } }
        );
    }

    const updated = await distributionRepository.findById(String(req.params.id));
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeDistributionRecord(updated),
            message: 'Xac nhan nhan hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportDistributionXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const record = await distributionRepository.findById(String(req.params.id));

    if (!record) {
        throw new NotFoundError('Khong tim thay phieu cap phat');
    }

    ensureDistributionAccess(req, record);

    if (!Array.isArray((record as any).items) || (record as any).items.length === 0) {
        throw new BadRequestError('Phieu cap phat khong co vat tu de xuat');
    }

    // Convert to plain object so generator reads fields correctly (not Mongoose proxies)
    const plain = serializeDistributionRecord(record);

    const { generateDistributionXlsx } = await import('@/utils/generateDistributionXlsx');
    const buffer = await generateDistributionXlsx(plain);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${record.distributionCode || 'distribution'}.xlsx"`);
    
    return res.status(StatusCodes.OK).send(buffer);
};
