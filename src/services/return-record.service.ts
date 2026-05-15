import { BadRequestError, NotFoundError } from '@/errors/customError';
import PurchaseOrder from '@/models/PurchaseOrder';
import ReturnRecord from '@/models/ReturnRecord';
import { returnRecordRepository } from '@/repositories/return-record.repository';
import { applyStockMovement, generateDocumentCode } from '@/services/material-workflow.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const normalizeReturnMaterialName = (value?: string) => value?.trim().replace(/\s+/g, ' ').toLowerCase() || '';

const getReturnItemKey = (item: any) => {
    if (item.materialId) return String(item.materialId);
    return normalizeReturnMaterialName(item.materialName);
};

export const createReturnRecord = async (req: Request, res: Response, next: NextFunction) => {
    const { purchaseOrderId, items, note, returnedAt } = req.body;

    const po = await PurchaseOrder.findOne({ _id: purchaseOrderId, isDeleted: { $ne: true } }).lean();
    if (!po) throw new NotFoundError('Không tìm thấy đơn đặt hàng');
    if ((po as any).status !== 'received')
        throw new BadRequestError('Chỉ có thể trả hàng cho đơn đã nhận (status=received)');

    const mainPlantId = process.env.MAIN_PLANT_ID;
    if (!mainPlantId) throw new BadRequestError('Chưa cấu hình MAIN_PLANT_ID');

    if (!Array.isArray(items) || !items.length)
        throw new BadRequestError('Phải có ít nhất 1 mặt hàng trả');

    // Build items + tính tiền — map supplierId từ PO items
    const poItems: any[] = (po as any).items ?? [];
    const returnableByKey = new Map<string, number>();
    const poItemByKey = new Map<string, any>();

    poItems.forEach((item) => {
        const key = getReturnItemKey(item);
        if (!key) return;

        const returnableQuantity = Number(item.quantityReceived ?? item.quantityOrdered ?? item.quantityRequested ?? 0);
        returnableByKey.set(key, Number(((returnableByKey.get(key) ?? 0) + returnableQuantity).toFixed(2)));
        if (!poItemByKey.has(key)) {
            poItemByKey.set(key, item);
        }
    });

    const existingReturns = await ReturnRecord.find({
        purchaseOrderId,
        isDeleted: { $ne: true },
    })
        .select('items')
        .lean();

    const returnedByKey = new Map<string, number>();
    existingReturns.forEach((record: any) => {
        (record.items ?? []).forEach((item: any) => {
            const key = getReturnItemKey(item);
            if (!key) return;
            returnedByKey.set(key, Number(((returnedByKey.get(key) ?? 0) + Number(item.quantityReturned ?? 0)).toFixed(2)));
        });
    });

    const requestedReturnByKey = new Map<string, number>();
    items.forEach((item: any) => {
        const key = getReturnItemKey(item);
        if (!key) {
            throw new BadRequestError('Dong tra hang thieu thong tin vat tu');
        }
        requestedReturnByKey.set(key, Number(((requestedReturnByKey.get(key) ?? 0) + Number(item.quantityReturned ?? 0)).toFixed(2)));
    });

    requestedReturnByKey.forEach((requestedQty, key) => {
        const returnableQty = returnableByKey.get(key) ?? 0;
        if (returnableQty <= 0) {
            const itemName = items.find((item: any) => getReturnItemKey(item) === key)?.materialName || key;
            throw new BadRequestError(`Vat tu "${itemName}" khong nam trong don mua hoac chua co so luong da nhan`);
        }

        const alreadyReturnedQty = returnedByKey.get(key) ?? 0;
        const remainingQty = Number((returnableQty - alreadyReturnedQty).toFixed(2));
        if (requestedQty > remainingQty) {
            const itemName =
                poItemByKey.get(key)?.materialName ||
                items.find((item: any) => getReturnItemKey(item) === key)?.materialName ||
                key;
            throw new BadRequestError(
                `So luong tra cua "${itemName}" vuot qua so luong con duoc tra: con ${remainingQty}, yeu cau ${requestedQty}`
            );
        }
    });

    const builtItems = items.map((item: any, idx: number) => {
        const qty = Number(item.quantityReturned ?? 0);
        if (qty <= 0) throw new BadRequestError(`Dòng ${idx + 1}: số lượng trả phải > 0`);
        const price = Number(item.unitPrice ?? 0);
        const vatRate = Number(item.vatRate ?? 0);
        const refundAmount = Number((qty * price).toFixed(2));
        const refundWithVat = Number((refundAmount * (1 + vatRate / 100)).toFixed(2));

        // Tìm supplierId từ PO item tương ứng (match theo materialId hoặc materialName)
        const poItem = poItemByKey.get(getReturnItemKey(item));

        return {
            materialId: item.materialId || undefined,
            materialName: item.materialName?.trim() || '',
            unit: item.unit?.trim() || '',
            supplierId: poItem?.supplierId || undefined,
            supplierName: poItem?.supplierName || item.supplierName || undefined,
            quantityReturned: qty,
            unitPrice: price,
            vatRate,
            refundAmount,
            refundWithVat,
            reason: item.reason?.trim() || undefined,
        };
    });

    const totalRefund = Number(builtItems.reduce((s, i) => s + i.refundAmount, 0).toFixed(2));
    const totalRefundWithVat = Number(builtItems.reduce((s, i) => s + i.refundWithVat, 0).toFixed(2));

    const returnCode = await generateDocumentCode({ model: ReturnRecord, field: 'returnCode', prefix: 'TH' });

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        // Trừ tồn kho CS1 cho từng item
        for (const item of builtItems) {
            if (!item.materialId) continue;
            await applyStockMovement({
                materialId: String(item.materialId),
                materialName: item.materialName,
                plantId: mainPlantId,
                quantity: -item.quantityReturned,
                type: 'export',
                relatedType: 'manual',
                performedBy: req.userId,
                note: `Trả hàng NCC - ${returnCode}`,
                session,
            });
        }

        await ReturnRecord.create([{
            returnCode,
            purchaseOrderId: po._id,
            purchaseOrderCode: (po as any).orderCode,
            supplierId: (po as any).supplierId || undefined,
            supplierName: (po as any).supplierName || undefined,
            plantId: mainPlantId,
            items: builtItems,
            totalRefund,
            totalRefundWithVat,
            returnedBy: req.userId,
            returnedAt: returnedAt ? new Date(returnedAt) : new Date(),
            note: note?.trim() || undefined,
        }], { session });

        await session.commitTransaction();
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
    }

    const created = await ReturnRecord.findOne({ returnCode }).lean();
    return res.status(StatusCodes.CREATED).json(
        customResponse({ data: created, message: 'Tạo phiếu trả hàng thành công', status: StatusCodes.CREATED, success: true })
    );
};

export const getReturnsByPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const { purchaseOrderId } = req.params;
    const records = await returnRecordRepository.findMany({ purchaseOrderId, isDeleted: { $ne: true } });
    return res.status(StatusCodes.OK).json(
        customResponse({ data: records, message: 'Lấy danh sách phiếu trả hàng thành công', status: StatusCodes.OK, success: true })
    );
};

export const getAllReturnRecords = async (req: Request, res: Response, next: NextFunction) => {
    const { page, limit, skip } = getPagination(req.query as any);
    const filter: any = { isDeleted: { $ne: true } };
    if (req.query.purchaseOrderId) filter.purchaseOrderId = req.query.purchaseOrderId;
    if (req.query.supplierId) filter.supplierId = req.query.supplierId;

    const [records, total] = await Promise.all([
        returnRecordRepository.findMany(filter, { skip, limit }),
        returnRecordRepository.countDocuments(filter),
    ]);
    return res.status(StatusCodes.OK).json(
        customResponse({ data: buildPaginatedResponse(records, total, page, limit), message: 'OK', status: StatusCodes.OK, success: true })
    );
};
