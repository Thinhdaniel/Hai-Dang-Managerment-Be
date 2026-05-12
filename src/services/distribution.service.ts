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
import { notifyAdmins, notifyUser, getActorName } from '@/services/notification.helper';
import { buildDistributionItems, getMaterialsMap } from '@/services/material-domain.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializeDistributionRecord } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildDistributionFilter = (query: Request['query'], req: Request) => {
    const conditions: Record<string, any>[] = [{ isDeleted: { $ne: true } }];

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        conditions.push({
            $or: [
                { distributionCode: regex },
                { note: regex },
                { requesterName: regex },
                { targetDepartment: regex },
                { targetLine: regex },
                { 'items.materialName': regex },
            ],
        });
    }

    if (query.status) {
        conditions.push({ status: query.status });
    }

    if (query.fromPlantId) {
        conditions.push({ fromPlantId: query.fromPlantId });
    }

    if (query.toPlantId) {
        conditions.push({ toPlantId: query.toPlantId });
    }

    if (query.distributionType) {
        conditions.push({ distributionType: query.distributionType });
    }

    if (query.startDate || query.endDate) {
        const createdAt: Record<string, any> = {};
        if (query.startDate) {
            createdAt.$gte = new Date(String(query.startDate));
        }
        if (query.endDate) {
            const endDate = new Date(String(query.endDate));
            endDate.setHours(23, 59, 59, 999);
            createdAt.$lte = endDate;
        }
        conditions.push({ createdAt });
    }

    if (query.supplyRequestId) {
        conditions.push({ supplyRequestId: query.supplyRequestId });
    }

    if (!isManagerRole(req.role)) {
        const userPlantId = getUserPlantId(req);
        conditions.push({ $or: [{ fromPlantId: userPlantId }, { toPlantId: userPlantId }] });
    }

    return conditions.length === 1 ? conditions[0] : { $and: conditions };
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

    const actorName = await getActorName(req.userId);
    await notifyUser(toId(sr.requestedBy)!, 'notify:new', {
        type: 'info',
        actionType: 'distribution',
        actionId: String((record as any)._id),
        title: 'Phiếu cấp phát đã được tạo',
        message: `${actorName} đã tạo phiếu cấp phát ${(created as any)?.distributionCode || ''} cho phiếu đề xuất ${(sr as any).requestCode || ''}`,
    });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeDistributionRecord(created),
            message: 'Tao phieu cap phat thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const createInternalDistributionRecord = async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const fromPlantId = getUserPlantId(req);
        if (!fromPlantId) throw new BadRequestError('Nguoi dung chua duoc gan co so');

        const isDraft = req.body.status === 'draft';

        const distributionCode = await generateDocumentCode({
            model: DistributionRecord,
            field: 'distributionCode',
            prefix: 'CPNB',
            session,
        });

        const materialIds: string[] = Array.from(
            new Set((req.body.items ?? []).map((item: any) => String(item.materialId)).filter(Boolean))
        );
        const materialsMap = await getMaterialsMap(materialIds, session);

        const builtItems = (req.body.items ?? []).map((item: any, idx: number) => {
            const material = materialsMap.get(String(item.materialId));
            if (!material) throw new BadRequestError(`Khong tim thay vat tu dong ${idx + 1}`);

            const qty = Number(item.quantity ?? 0);
            if (qty <= 0) throw new BadRequestError(`Item ${idx + 1}: so luong cap phat phai lon hon 0`);

            const unitPrice = Number(item.unitPrice ?? 0);
            const vatRate = Number(item.vatRate ?? 0);
            const totalPrice = Number((qty * unitPrice).toFixed(2));
            const vatAmount = Number((totalPrice * vatRate / 100).toFixed(2));
            const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));

            return {
                materialId: material._id,
                materialName: material.name,
                unit: item.unit?.trim() || material.unit,
                quantityRequested: Number(item.quantityRequested ?? qty),
                quantity: qty,
                unitPrice,
                totalPrice,
                vatRate,
                vatAmount,
                totalWithVat,
                adjustReason: item.adjustReason?.trim() || undefined,
                note: item.note?.trim() || undefined,
            };
        });

        const distributedAt = req.body.distributedAt ? new Date(req.body.distributedAt) : new Date();
        const totalAmount = Number(builtItems.reduce((sum: number, item: any) => sum + (item.totalPrice ?? 0), 0).toFixed(2));
        const totalVatAmount = Number(builtItems.reduce((sum: number, item: any) => sum + (item.vatAmount ?? 0), 0).toFixed(2));
        const totalWithVat = Number(builtItems.reduce((sum: number, item: any) => sum + (item.totalWithVat ?? 0), 0).toFixed(2));

        const recordData: any = {
            distributionCode,
            distributionType: 'internal_issue',
            fromPlantId,
            toPlantId: fromPlantId,
            status: isDraft ? 'draft' : 'confirmed',
            requesterName: req.body.requesterName?.trim(),
            targetDepartment: req.body.targetDepartment?.trim() || undefined,
            targetLine: req.body.targetLine?.trim() || undefined,
            items: builtItems,
            totalAmount,
            totalVatAmount,
            totalWithVat,
            distributedBy: req.userId,
            distributedAt,
            note: req.body.note?.trim() || undefined,
        };

        if (!isDraft) {
            recordData.confirmedBy = req.userId;
            recordData.confirmedAt = distributedAt;
        }

        const record = await distributionRepository.create(recordData, session);

        if (!isDraft) {
            for (const item of builtItems) {
                await applyStockMovement({
                    materialId: String(item.materialId),
                    materialName: item.materialName,
                    plantId: fromPlantId,
                    quantity: -Number(item.quantity ?? 0),
                    type: 'export',
                    relatedId: String((record as any)._id),
                    relatedType: 'distribution',
                    performedBy: req.userId,
                    note: `Cap phat noi bo ${distributionCode}`,
                    session,
                });
            }
        }

        await session.commitTransaction();

        const created = await distributionRepository.findById(String((record as any)._id));

        return res.status(StatusCodes.CREATED).json(
            customResponse({
                data: serializeDistributionRecord(created),
                message: isDraft ? 'Tao phieu cap phat noi bo (nhap) thanh cong' : 'Tao phieu cap phat noi bo thanh cong',
                status: StatusCodes.CREATED,
                success: true,
            })
        );
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
};

/** Thêm vật tư vào phiếu nội bộ đang draft */
export const appendInternalItems = async (req: Request, res: Response, next: NextFunction) => {
    const record = await distributionRepository.findById(String(req.params.id));
    if (!record) throw new NotFoundError('Khong tim thay phieu cap phat');
    if ((record as any).distributionType !== 'internal_issue') throw new BadRequestError('Chi ap dung cho phieu cap phat noi bo');
    if ((record as any).status !== 'draft') throw new BadRequestError('Chi co the them vat tu vao phieu dang nhap');

    const fromPlantId = getUserPlantId(req);
    if (!isManagerRole(req.role) && toId((record as any).distributedBy) !== req.userId) {
        throw new UnAuthorizedError('Ban khong co quyen chinh sua phieu nay');
    }

    const materialIds = (req.body.items ?? []).map((i: any) => String(i.materialId));
    const materialsMap = await getMaterialsMap(materialIds);

    const newItems = (req.body.items ?? []).map((item: any, idx: number) => {
        const material = materialsMap.get(String(item.materialId));
        if (!material) throw new BadRequestError(`Khong tim thay vat tu dong ${idx + 1}`);

        const qty = Number(item.quantity ?? 0);
        if (qty <= 0) throw new BadRequestError(`Item ${idx + 1}: so luong phai lon hon 0`);

        const unitPrice = Number(item.unitPrice ?? 0);
        const vatRate = Number(item.vatRate ?? 0);
        const totalPrice = Number((qty * unitPrice).toFixed(2));
        const vatAmount = Number((totalPrice * vatRate / 100).toFixed(2));

        return {
            materialId: material._id,
            materialName: material.name,
            unit: item.unit?.trim() || material.unit,
            quantityRequested: Number(item.quantityRequested ?? qty),
            quantity: qty,
            unitPrice,
            totalPrice,
            vatRate,
            vatAmount,
            totalWithVat: Number((totalPrice + vatAmount).toFixed(2)),
            note: item.note?.trim() || undefined,
        };
    });

    const allItems = [...((record as any).items ?? []).map((i: any) => i.toObject ? i.toObject() : i), ...newItems];
    const totalAmount = Number(allItems.reduce((s: number, i: any) => s + (i.totalPrice ?? 0), 0).toFixed(2));
    const totalVatAmount = Number(allItems.reduce((s: number, i: any) => s + (i.vatAmount ?? 0), 0).toFixed(2));
    const totalWithVat = Number(allItems.reduce((s: number, i: any) => s + (i.totalWithVat ?? 0), 0).toFixed(2));

    await (DistributionRecord as any).updateOne(
        { _id: (record as any)._id },
        { $set: { items: allItems, totalAmount, totalVatAmount, totalWithVat } }
    );

    const updated = await distributionRepository.findById(String(req.params.id));
    return res.status(StatusCodes.OK).json(
        customResponse({ data: serializeDistributionRecord(updated), message: 'Da them vat tu vao phieu nhap', status: StatusCodes.OK, success: true })
    );
};

/** Chốt phiếu nội bộ draft → trừ kho */
export const finalizeInternalDraft = async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const record = await (DistributionRecord as any)
            .findOneAndUpdate(
                { _id: req.params.id, status: 'draft', distributionType: 'internal_issue', isDeleted: { $ne: true } },
                { $set: { status: 'processing' } },
                { new: false, session }
            );

        if (!record) {
            const exists = await (DistributionRecord as any).findById(req.params.id).session(session);
            if (!exists) throw new NotFoundError('Khong tim thay phieu cap phat');
            throw new BadRequestError('Phieu khong o trang thai nhap hoac da duoc xu ly');
        }

        if (!isManagerRole(req.role) && toId(record.distributedBy) !== req.userId) {
            throw new UnAuthorizedError('Ban khong co quyen chot phieu nay');
        }

        const fromPlantId = toId(record.fromPlantId);
        const now = new Date();

        for (const item of record.items ?? []) {
            const qty = Number(item.quantity ?? 0);
            if (qty <= 0 || !item.materialId) continue;

            await applyStockMovement({
                materialId: String(item.materialId),
                materialName: item.materialName,
                plantId: String(fromPlantId),
                quantity: -qty,
                type: 'export',
                relatedId: String(record._id),
                relatedType: 'distribution',
                performedBy: req.userId,
                note: `Chot phieu cap phat noi bo ${record.distributionCode}`,
                session,
            });
        }

        await (DistributionRecord as any).updateOne(
            { _id: record._id },
            { $set: { status: 'confirmed', confirmedBy: req.userId, confirmedAt: now, distributedAt: now } },
            { session }
        );

        await session.commitTransaction();

        const updated = await distributionRepository.findById(String(req.params.id));
        return res.status(StatusCodes.OK).json(
            customResponse({ data: serializeDistributionRecord(updated), message: 'Chot phieu cap phat noi bo thanh cong', status: StatusCodes.OK, success: true })
        );
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
    }
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

    const actorName = await getActorName(req.userId);
    // Notify người tạo SR (CS nhận) biết hàng đã được xuất kho
    const srDoc = updated && (updated as any).supplyRequestId
        ? await PurchaseRequest.findById((updated as any).supplyRequestId).select('requestedBy requestCode').lean()
        : null;
    if (srDoc) {
        await notifyUser(toId(srDoc.requestedBy)!, 'notify:new', {
            type: 'success',
            actionType: 'distribution',
            actionId: String(req.params.id),
            title: 'Vật tư đã được xuất kho',
            message: `${actorName} đã xuất kho phiếu cấp phát ${(updated as any)?.distributionCode || ''}. Vui lòng xác nhận nhận hàng.`,
        });
    }

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

    const actorName = await getActorName(req.userId);
    await notifyAdmins('notify:new', {
        type: 'success',
        actionType: 'distribution',
        actionId: String(req.params.id),
        title: 'Xác nhận nhận hàng',
        message: `${actorName} đã xác nhận nhận hàng phiếu cấp phát ${(updated as any)?.distributionCode || ''}`,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeDistributionRecord(updated),
            message: 'Xac nhan nhan hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updateDistributionRecord = async (req: Request, res: Response, next: NextFunction) => {
    const record = await distributionRepository.findById(String(req.params.id));
    if (!record) throw new NotFoundError('Khong tim thay phieu cap phat');

    ensureDistributionAccess(req, record);

    const { items, note } = req.body;

    const updateData: Record<string, any> = {};

    if (note !== undefined) {
        updateData.note = note?.trim() || undefined;
    }

    if (Array.isArray(items) && items.length > 0) {
        const currentItems: any[] = (record as any).items ?? [];

        const updatedItems = currentItems.map((item: any, idx: number) => {
            const patch = items.find((i: any) => i.index === idx) ?? items[idx];
            if (!patch) return item;

            const qty = Number(item.quantity ?? 0);
            const unitPrice = patch.unitPrice !== undefined ? Number(patch.unitPrice) : Number(item.unitPrice ?? 0);
            const vatRate = patch.vatRate !== undefined ? Number(patch.vatRate) : Number(item.vatRate ?? 0);
            const totalPrice = Number((qty * unitPrice).toFixed(2));
            const vatAmount = Number((totalPrice * vatRate / 100).toFixed(2));
            const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));

            return {
                ...item.toObject ? item.toObject() : item,
                unitPrice,
                vatRate,
                totalPrice,
                vatAmount,
                totalWithVat,
                note: patch.note !== undefined ? patch.note?.trim() || undefined : item.note,
            };
        });

        updateData.items = updatedItems;
        updateData.totalAmount = Number(updatedItems.reduce((s: number, i: any) => s + (i.totalPrice ?? 0), 0).toFixed(2));
        updateData.totalVatAmount = Number(updatedItems.reduce((s: number, i: any) => s + (i.vatAmount ?? 0), 0).toFixed(2));
        updateData.totalWithVat = Number(updatedItems.reduce((s: number, i: any) => s + (i.totalWithVat ?? 0), 0).toFixed(2));
    }

    await (DistributionRecord as any).updateOne({ _id: (record as any)._id }, { $set: updateData });

    const updated = await distributionRepository.findById(String(req.params.id));
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeDistributionRecord(updated),
            message: 'Cap nhat phieu cap phat thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportRangeDistributionXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildDistributionFilter(req.query, req);
    const records = await distributionRepository.findMany(filter, { sort: 'createdAt' });

    if (!records.length) {
        throw new BadRequestError('Khong co phieu cap phat nao trong khoang thoi gian nay');
    }

    const plains = records.map(serializeDistributionRecord);

    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const label = startDate && endDate
        ? `${startDate} den ${endDate}`
        : startDate || endDate || 'Tat ca';

    const { generateRangeDistributionXlsx } = await import('@/utils/generateRangeDistributionXlsx');
    const buffer = await generateRangeDistributionXlsx(plains, label);

    const filename = `cap-phat-${label.replace(/\//g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(StatusCodes.OK).send(buffer);
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
