import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import DistributionRecord from '@/models/DistributionRecord';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import StockTransaction from '@/models/StockTransaction';
import PurchaseRequest from '@/models/PurchaseRequest';
import SupplyShortage from '@/models/SupplyShortage';
import { distributionRepository } from '@/repositories/distribution.repository';
import {
    generateDocumentCode,
    getUserPlantId,
    isManagerRole,
    toId,
} from '@/services/material-workflow.helpers';
import { notifyAdmins, notifyUser, getActorName } from '@/services/notification.helper';
import { getMaterialsMap } from '@/services/material-domain.helpers';
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

const getRequestedQuantity = (item: any) => Number(item?.quantityApproved ?? item?.quantityRequested ?? 0);

const buildDistributionRecordItems = async (items: any[], session?: mongoose.ClientSession) => {
    const materialIds = Array.from(new Set((items ?? []).map((item: any) => toId(item.materialId)).filter(Boolean))) as string[];
    const materialsMap = await getMaterialsMap(materialIds, session);

    return (items ?? []).map((item: any, idx: number) => {
        const materialId = toId(item.materialId);
        const material = materialId ? materialsMap.get(materialId) : undefined;
        const catalogStatus = item.catalogStatus || (material ? 'matched' : 'unmatched');

        const qty = Number(item.quantity ?? 0);
        const fulfillmentStatus = item.fulfillmentStatus === 'not_supplied' || qty === 0 ? 'not_supplied' : item.fulfillmentStatus;

        if (!material && catalogStatus !== 'ignored' && fulfillmentStatus !== 'not_supplied') {
            throw new BadRequestError(`Dong ${idx + 1}: vui long gan vat tu kho hoac chon bo qua ton kho`);
        }

        const materialName = material?.name || item.materialName?.trim();
        const unit = item.unit?.trim() || material?.unit;
        if (!materialName) throw new BadRequestError(`Dong ${idx + 1}: ten vat tu khong duoc de trong`);
        if (!unit) throw new BadRequestError(`Dong ${idx + 1}: don vi tinh khong duoc de trong`);

        if (qty < 0) throw new BadRequestError(`Item ${idx + 1}: so luong cap phat khong hop le`);
        if (qty === 0 && fulfillmentStatus !== 'not_supplied') {
            throw new BadRequestError(`Item ${idx + 1}: so luong cap phat phai lon hon 0 hoac danh dau khong cap duoc`);
        }

        const unitPrice = Number(item.unitPrice ?? 0);
        if (unitPrice < 0) throw new BadRequestError(`Item ${idx + 1}: don gia khong hop le`);

        const vatRate = Number(item.vatRate ?? 0);
        if (vatRate < 0) throw new BadRequestError(`Item ${idx + 1}: VAT khong hop le`);

        const totalPrice = Number((qty * unitPrice).toFixed(2));
        const vatAmount = Number((totalPrice * vatRate / 100).toFixed(2));
        const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));
        const normalizedCatalogStatus = catalogStatus === 'ignored' || fulfillmentStatus === 'not_supplied' ? 'ignored' : material ? 'matched' : 'ignored';
        const skipInventory = normalizedCatalogStatus === 'ignored' || qty === 0;
        const quantityRequested = Number(item.quantityRequested ?? qty);
        const quantityShortage = Number(item.quantityShortage ?? Math.max(0, quantityRequested - qty));

        return {
            materialId: material?._id,
            materialName,
            unit,
            quantityRequested,
            quantity: qty,
            quantityDistributed: qty,
            quantityShortage,
            sourceRequestItemIndex: item.sourceRequestItemIndex,
            sourceShortageId: toId(item.sourceShortageId),
            fulfillmentStatus: fulfillmentStatus || (quantityShortage > 0 ? 'partial' : 'fulfilled'),
            unitPrice,
            totalPrice,
            vatRate,
            vatAmount,
            totalWithVat,
            catalogStatus: normalizedCatalogStatus,
            quantityInventoried: 0,
            inventoryStatus: skipInventory || !material ? 'skipped' : 'pending',
            inventorySkipReason:
                item.inventorySkipReason?.trim() || (skipInventory || !material ? 'Khong theo doi ton kho' : undefined),
            adjustReason: item.adjustReason?.trim() || undefined,
            note: item.note?.trim() || undefined,
        };
    });
};

const applySupplyRequestFulfillment = (items: any[], requestItems: any[]) => {
    const hasExplicitIndexes = items.some((item) => item.sourceRequestItemIndex !== undefined && item.sourceRequestItemIndex !== null);
    const grouped = new Map<number, any[]>();

    items.forEach((item, idx) => {
        const sourceIndex = hasExplicitIndexes ? Number(item.sourceRequestItemIndex ?? idx) : idx;
        item.sourceRequestItemIndex = sourceIndex;
        grouped.set(sourceIndex, [...(grouped.get(sourceIndex) ?? []), item]);
    });

    for (const [sourceIndex, rows] of grouped.entries()) {
        const requestItem = requestItems[sourceIndex];
        const requestedQty = getRequestedQuantity(requestItem) || Math.max(...rows.map((row) => Number(row.quantityRequested ?? 0)));
        const distributedQty = rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);

        if (requestedQty > 0 && distributedQty > requestedQty) {
            throw new BadRequestError(
                `Dong ${sourceIndex + 1}: so luong cap phat (${distributedQty}) vuot qua so luong duyet (${requestedQty})`
            );
        }

        const shortageQty = Number(Math.max(0, requestedQty - distributedQty).toFixed(2));
        const status = distributedQty <= 0 ? 'not_supplied' : shortageQty > 0 ? 'partial' : 'fulfilled';

        rows.forEach((row, rowIndex) => {
            row.quantityRequested = requestedQty;
            row.quantityDistributed = Number(row.quantity ?? 0);
            row.quantityShortage = rowIndex === 0 ? shortageQty : 0;
            row.fulfillmentStatus = status;
        });
    }

    return items;
};

const summarizeDistributionItems = (items: any[]) => ({
    totalAmount: Number(items.reduce((sum: number, item: any) => sum + Number(item.totalPrice ?? 0), 0).toFixed(2)),
    totalVatAmount: Number(items.reduce((sum: number, item: any) => sum + Number(item.vatAmount ?? 0), 0).toFixed(2)),
    totalWithVat: Number(items.reduce((sum: number, item: any) => sum + Number(item.totalWithVat ?? 0), 0).toFixed(2)),
});

const createSupplyShortagesForDistribution = async ({
    supplyRequest,
    distribution,
    items,
    session,
}: {
    supplyRequest: any;
    distribution: any;
    items: any[];
    session?: mongoose.ClientSession;
}) => {
    const requestItems = (supplyRequest as any).items ?? [];
    const toPlantId = toId((supplyRequest as any).fromPlantId) || toId((supplyRequest as any).plantId);
    if (!toPlantId) return;

    const grouped = new Map<number, any[]>();
    items.forEach((item, idx) => {
        const sourceIndex = Number(item.sourceRequestItemIndex ?? idx);
        grouped.set(sourceIndex, [...(grouped.get(sourceIndex) ?? []), item]);
    });

    for (const [sourceIndex, rows] of grouped.entries()) {
        const requestItem = requestItems[sourceIndex];
        if (!requestItem) continue;

        const quantityRequested = getRequestedQuantity(requestItem);
        const quantityDistributed = Number(rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0).toFixed(2));
        const quantityShortage = Number(Math.max(0, quantityRequested - quantityDistributed).toFixed(2));

        if (quantityShortage <= 0) continue;

        const firstRow = rows.find((row) => row.materialName || row.materialId) ?? rows[0];
        const reason = rows.find((row) => row.adjustReason || row.note)?.adjustReason || rows.find((row) => row.adjustReason || row.note)?.note;

        await SupplyShortage.updateOne(
            {
                originalSupplyRequestId: (supplyRequest as any)._id,
                originalItemIndex: sourceIndex,
                originalDistributionId: (distribution as any)._id,
                isDeleted: { $ne: true },
            },
            {
                $setOnInsert: {
                    originalSupplyRequestId: (supplyRequest as any)._id,
                    originalSupplyRequestCode: (supplyRequest as any).requestCode,
                    originalDistributionId: (distribution as any)._id,
                    originalDistributionCode: (distribution as any).distributionCode,
                    originalItemIndex: sourceIndex,
                    toPlantId,
                    materialId: toId(firstRow?.materialId) || toId(requestItem?.materialId),
                    materialName: firstRow?.materialName || requestItem?.materialName,
                    unit: firstRow?.unit || requestItem?.unit,
                    quantityRequested,
                    quantityDistributed,
                    quantityShortage,
                    quantityResolved: 0,
                    status: 'outstanding',
                    reason,
                    note: firstRow?.note,
                },
            },
            { upsert: true, session }
        );
    }
};

const refreshSupplyRequestFulfillmentStatus = async (supplyRequestId?: string, session?: mongoose.ClientSession) => {
    if (!supplyRequestId) return;

    const openQuery = SupplyShortage.countDocuments({
        originalSupplyRequestId: supplyRequestId,
        status: { $in: ['outstanding', 'partially_settled'] },
        isDeleted: { $ne: true },
    });
    if (session) openQuery.session(session);
    const openCount = await openQuery;

    await PurchaseRequest.updateOne(
        { _id: supplyRequestId },
        { $set: { status: openCount > 0 ? 'partially_distributed' : 'distributed' } },
        { session }
    );
};

const applySupplyShortageResolutions = async ({
    record,
    performedBy,
    session,
}: {
    record: any;
    performedBy?: string;
    session: mongoose.ClientSession;
}) => {
    if (!(record as any).isCompensation) return;

    const supplyRequestIds = new Set<string>();
    for (const item of (record as any).items ?? []) {
        const sourceShortageId = toId(item.sourceShortageId);
        const quantity = Number(item.quantity ?? 0);
        if (!sourceShortageId || quantity <= 0) continue;

        const shortage = await SupplyShortage.findOne({
            _id: sourceShortageId,
            status: { $in: ['outstanding', 'partially_settled'] },
            isDeleted: { $ne: true },
        }).session(session);

        if (!shortage) {
            throw new BadRequestError(`Dong cap bu khong ton tai hoac da hoan tat`);
        }

        const outstanding = Number(shortage.quantityShortage ?? 0) - Number(shortage.quantityResolved ?? 0);
        if (quantity > outstanding) {
            throw new BadRequestError(`So luong cap bu cho "${shortage.materialName}" vuot qua so luong con thieu`);
        }

        shortage.quantityResolved = Number((Number(shortage.quantityResolved ?? 0) + quantity).toFixed(2));
        shortage.status =
            shortage.quantityResolved >= Number(shortage.quantityShortage ?? 0)
                ? 'settled'
                : shortage.quantityResolved > 0
                  ? 'partially_settled'
                  : 'outstanding';
        shortage.resolutions.push({
            distributionId: (record as any)._id,
            distributionCode: (record as any).distributionCode,
            quantity,
            resolvedBy: performedBy,
            resolvedAt: new Date(),
            note: item.note,
        });

        await shortage.save({ session });
        const requestId = toId(shortage.originalSupplyRequestId);
        if (requestId) supplyRequestIds.add(requestId);
    }

    for (const supplyRequestId of supplyRequestIds) {
        await refreshSupplyRequestFulfillmentStatus(supplyRequestId, session);
    }
};

const exportDistributionItemStock = async ({
    item,
    plantId,
    recordId,
    distributionCode,
    performedBy,
    session,
}: {
    item: any;
    plantId: string;
    recordId: string;
    distributionCode?: string;
    performedBy?: string;
    session: mongoose.ClientSession;
}) => {
    const plain = item.toObject ? item.toObject() : { ...item };
    const qty = Number(plain.quantity ?? 0);
    if (qty <= 0) return plain;

    const materialIdValue = toId(plain.materialId);
    if (!materialIdValue) {
        if (plain.catalogStatus === 'ignored') {
            return {
                ...plain,
                inventoryStatus: 'skipped',
                inventorySkipReason: plain.inventorySkipReason || 'Khong theo doi ton kho',
                quantityInventoried: 0,
            };
        }
        throw new BadRequestError(`Dong "${plain.materialName || ''}" chua gan vat tu kho`);
    }

    const material = await Material.findOne({
        _id: materialIdValue,
        isDeleted: { $ne: true },
        isActive: { $ne: false },
    }).session(session);

    if (!material) {
        throw new NotFoundError(`Khong tim thay vat tu "${plain.materialName || materialIdValue}"`);
    }

    if (plain.catalogStatus === 'ignored' || (material as any).trackInventory === false) {
        return {
            ...plain,
            materialName: plain.materialName || material.name,
            unit: plain.unit || material.unit,
            inventoryStatus: 'skipped',
            inventorySkipReason:
                plain.inventorySkipReason || ((material as any).trackInventory === false ? 'Vat tu khong theo doi ton kho' : 'Khong theo doi ton kho'),
            quantityInventoried: 0,
        };
    }

    const materialObjectId = new mongoose.Types.ObjectId(materialIdValue);
    const plantObjectId = new mongoose.Types.ObjectId(plantId);
    const stock = await (InventoryStock as any)
        .findOne({ materialId: materialObjectId, plantId: plantObjectId, isDeleted: { $ne: true } })
        .session(session);
    const stockBefore = Number(stock?.currentStock ?? 0);

    if (stockBefore < qty) {
        throw new BadRequestError(
            `Ton kho khong du cho vat tu "${plain.materialName || material.name}": can ${qty}, con ${stockBefore}`
        );
    }

    await (InventoryStock as any).updateOne(
        { _id: stock._id },
        { $set: { currentStock: stockBefore - qty } },
        { session }
    );

    await StockTransaction.create(
        [
            {
                type: 'export',
                materialId: materialObjectId,
                materialName: plain.materialName || material.name,
                plantId: plantObjectId,
                quantity: -qty,
                stockBefore,
                stockAfter: stockBefore - qty,
                relatedId: recordId,
                relatedType: 'distribution',
                performedBy,
                note: `Xuat kho cap phat ${distributionCode || ''}`.trim(),
            },
        ],
        { session }
    );

    return {
        ...plain,
        materialName: plain.materialName || material.name,
        unit: plain.unit || material.unit,
        quantityInventoried: Number(plain.quantityInventoried ?? 0) + qty,
        inventoryStatus: 'applied',
        inventorySkipReason: undefined,
    };
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
    const { supplyRequestId, distributedAt, items, note } = req.body;

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
        isCompensation: { $ne: true },
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

    const builtItems = applySupplyRequestFulfillment(
        await buildDistributionRecordItems(items ?? []),
        ((sr as any).items ?? []) as any[]
    );
    const totals = summarizeDistributionItems(builtItems);

    const record = await distributionRepository.create({
        distributionCode,
        supplyRequestId: sr._id,
        fromPlantId: mainPlantId,
        toPlantId,
        status: 'pending',
        items: builtItems,
        totalAmount: totals.totalAmount,
        totalVatAmount: totals.totalVatAmount,
        totalWithVat: totals.totalWithVat,
        distributedAt: distributedAt ? new Date(distributedAt) : undefined,
        note: note?.trim() || undefined,
    });

    // 4. Cập nhật SR status
    await PurchaseRequest.updateOne({ _id: sr._id }, { $set: { status: 'in_progress' } });
    await createSupplyShortagesForDistribution({ supplyRequest: sr, distribution: record, items: builtItems });

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

export const createCompensationDistributionRecord = async (req: Request, res: Response, next: NextFunction) => {
    const { shortageIds, distributedAt, items, note } = req.body;
    const uniqueShortageIds = Array.from(new Set<string>((shortageIds ?? []).map(String)));

    const shortages = await SupplyShortage.find({
        _id: { $in: uniqueShortageIds },
        status: { $in: ['outstanding', 'partially_settled'] },
        isDeleted: { $ne: true },
    });

    if (shortages.length !== uniqueShortageIds.length) {
        throw new BadRequestError('Mot so dong cap bu khong ton tai hoac da hoan tat');
    }

    const toPlantIds = new Set(shortages.map((shortage: any) => toId(shortage.toPlantId)).filter(Boolean));
    if (toPlantIds.size !== 1) throw new BadRequestError('Chi co the tao mot phieu cap bu cho cung mot co so nhan');

    const supplyRequestIds = new Set(shortages.map((shortage: any) => toId(shortage.originalSupplyRequestId)).filter(Boolean));
    if (supplyRequestIds.size !== 1) throw new BadRequestError('Chi co the tao mot phieu cap bu cho cung mot de xuat goc');

    const shortagesById = new Map(shortages.map((shortage: any) => [String(shortage._id), shortage]));
    const normalizedItems = (items ?? []).map((item: any, idx: number) => {
        const sourceShortageId = toId(item.sourceShortageId) || uniqueShortageIds[idx];
        const shortage = sourceShortageId ? shortagesById.get(sourceShortageId) : undefined;
        if (!shortage) throw new BadRequestError(`Dong ${idx + 1}: chua gan dong cap bu`);

        const outstanding = Number(shortage.quantityShortage ?? 0) - Number(shortage.quantityResolved ?? 0);
        return {
            ...item,
            sourceShortageId,
            materialId: item.materialId || toId(shortage.materialId),
            materialName: item.materialName || shortage.materialName,
            unit: item.unit || shortage.unit,
            quantityRequested: outstanding,
            sourceRequestItemIndex: shortage.originalItemIndex,
        };
    });

    const quantityByShortage = new Map<string, number>();
    normalizedItems.forEach((item: any) => {
        const key = String(item.sourceShortageId);
        quantityByShortage.set(key, Number((Number(quantityByShortage.get(key) ?? 0) + Number(item.quantity ?? 0)).toFixed(2)));
    });

    for (const [shortageId, quantity] of quantityByShortage.entries()) {
        const shortage = shortagesById.get(shortageId);
        const outstanding = Number(shortage.quantityShortage ?? 0) - Number(shortage.quantityResolved ?? 0);
        if (quantity > outstanding) {
            throw new BadRequestError(`So luong cap bu cho "${shortage.materialName}" vuot qua so luong con thieu`);
        }
    }

    const distributionCode = await generateDocumentCode({
        model: DistributionRecord,
        field: 'distributionCode',
        prefix: 'CPB',
    });

    const mainPlantId = process.env.MAIN_PLANT_ID;
    if (!mainPlantId) throw new BadRequestError('Chua cau hinh MAIN_PLANT_ID');

    const builtItems = await buildDistributionRecordItems(normalizedItems);
    const totals = summarizeDistributionItems(builtItems);
    const [firstShortage] = shortages as any[];

    const record = await distributionRepository.create({
        distributionCode,
        distributionType: 'facility_transfer',
        isCompensation: true,
        compensationForShortageIds: uniqueShortageIds,
        supplyRequestId: firstShortage.originalSupplyRequestId,
        fromPlantId: mainPlantId,
        toPlantId: firstShortage.toPlantId,
        status: 'pending',
        items: builtItems,
        totalAmount: totals.totalAmount,
        totalVatAmount: totals.totalVatAmount,
        totalWithVat: totals.totalWithVat,
        distributedAt: distributedAt ? new Date(distributedAt) : undefined,
        note: note?.trim() || undefined,
    });

    const created = await distributionRepository.findById(String((record as any)._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeDistributionRecord(created),
            message: 'Tao phieu cap bu thanh cong',
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

        const builtItems = await buildDistributionRecordItems(req.body.items ?? [], session);

        const distributedAt = req.body.distributedAt ? new Date(req.body.distributedAt) : new Date();
        const totals = summarizeDistributionItems(builtItems);

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
            totalAmount: totals.totalAmount,
            totalVatAmount: totals.totalVatAmount,
            totalWithVat: totals.totalWithVat,
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
            const inventoriedItems = [];
            for (const item of builtItems) {
                inventoriedItems.push(
                    await exportDistributionItemStock({
                        item,
                        plantId: fromPlantId,
                        recordId: String((record as any)._id),
                        distributionCode,
                        performedBy: req.userId,
                        session,
                    })
                );
            }
            await (DistributionRecord as any).updateOne({ _id: (record as any)._id }, { $set: { items: inventoriedItems } }, { session });
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

    const newItems = await buildDistributionRecordItems(req.body.items ?? []);

    const allItems = [...((record as any).items ?? []).map((i: any) => i.toObject ? i.toObject() : i), ...newItems];
    const totals = summarizeDistributionItems(allItems);

    await (DistributionRecord as any).updateOne(
        { _id: (record as any)._id },
        { $set: { items: allItems, ...totals } }
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

        const inventoriedItems = [];
        for (const item of record.items ?? []) {
            inventoriedItems.push(
                await exportDistributionItemStock({
                    item,
                    plantId: String(fromPlantId),
                    recordId: String(record._id),
                    distributionCode: record.distributionCode,
                    performedBy: req.userId,
                    session,
                })
            );
        }

        await applySupplyShortageResolutions({ record, performedBy: req.userId, session });

        await (DistributionRecord as any).updateOne(
            { _id: record._id },
            { $set: { status: 'confirmed', confirmedBy: req.userId, confirmedAt: now, distributedAt: now, items: inventoriedItems } },
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

        const mainPlantId = process.env.MAIN_PLANT_ID;
        if (!mainPlantId) throw new BadRequestError('Chua cau hinh MAIN_PLANT_ID');
        const inventoriedItems = [];
        for (const item of record.items ?? []) {
            inventoriedItems.push(
                await exportDistributionItemStock({
                    item,
                    plantId: mainPlantId,
                    recordId: String(record._id),
                    distributionCode: record.distributionCode,
                    performedBy: req.userId,
                    session,
                })
            );
        }

        await (DistributionRecord as any).updateOne(
            { _id: record._id },
            { $set: { status: 'distributed', distributedBy: req.userId, distributedAt: new Date(), items: inventoriedItems } },
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
        await refreshSupplyRequestFulfillmentStatus(supplyRequestId);
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

    const recordIds = records.map((record: any) => String(record._id));
    const shortages = await SupplyShortage.find({
        originalDistributionId: { $in: recordIds },
        isDeleted: { $ne: true },
    }).lean();
    const shortagesByDistribution = new Map<string, any[]>();
    shortages.forEach((shortage: any) => {
        const key = String(shortage.originalDistributionId);
        shortagesByDistribution.set(key, [...(shortagesByDistribution.get(key) ?? []), shortage]);
    });

    const plains = records.map((record: any) => ({
        ...serializeDistributionRecord(record),
        supplyShortages: shortagesByDistribution.get(String(record._id)) ?? [],
    }));

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
    const shortages = await SupplyShortage.find({
        originalDistributionId: (record as any)._id,
        isDeleted: { $ne: true },
    }).lean();

    const plain = {
        ...serializeDistributionRecord(record),
        supplyShortages: shortages,
    };

    const { generateDistributionXlsx } = await import('@/utils/generateDistributionXlsx');
    const buffer = await generateDistributionXlsx(plain);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${record.distributionCode || 'distribution'}.xlsx"`);
    
    return res.status(StatusCodes.OK).send(buffer);
};
