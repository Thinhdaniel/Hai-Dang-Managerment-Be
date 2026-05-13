import { BadRequestError, NotFoundError } from '@/errors/customError';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import StockTransaction from '@/models/StockTransaction';
import { purchaseOrderRepository } from '@/repositories/purchase-order.repository';
import { generateDocumentCode, toId } from '@/services/material-workflow.helpers';
import { notifyAdmins, getActorName } from '@/services/notification.helper';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializePurchaseOrder } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const MAIN_PLANT_ID = process.env.MAIN_PLANT_ID || '';

const calcItem = (item: any) => {
    const qty = Number(item.quantityOrdered ?? 0);
    const price = Number(item.unitPrice ?? 0);
    const totalPrice = Number((qty * price).toFixed(2));
    const vatRate = Number(item.vatRate ?? 0);
    const vatAmount = Number((totalPrice * vatRate / 100).toFixed(2));
    return { ...item, totalPrice, vatAmount, totalWithVat: Number((totalPrice + vatAmount).toFixed(2)) };
};

const calcTotals = (items: any[]) => ({
    totalAmount: Number(items.reduce((s, i) => s + (i.totalPrice ?? 0), 0).toFixed(2)),
    totalVat: Number(items.reduce((s, i) => s + (i.vatAmount ?? 0), 0).toFixed(2)),
    totalWithVat: Number(items.reduce((s, i) => s + (i.totalWithVat ?? 0), 0).toFixed(2)),
});

const deriveSingleSupplier = (items: any[]) => {
    const suppliers = new Map<string, { supplierId?: any; supplierName?: string }>();

    items.forEach((item) => {
        const supplierId = toId(item.supplierId);
        const supplierName = item.supplierName || item.supplierId?.name;
        const key = supplierId || supplierName;
        if (!key) return;
        suppliers.set(key, { supplierId: item.supplierId, supplierName });
    });

    const values = Array.from(suppliers.values());
    return values.length === 1 ? values[0] : { supplierId: undefined, supplierName: undefined };
};

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });
    if (regex) filter.$or = [{ orderCode: regex }, { 'items.materialName': regex }, { 'items.supplierName': regex }];
    if (query.status) filter.status = query.status;
    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) filter.createdAt.$gte = new Date(String(query.startDate));
        if (query.endDate) { const d = new Date(String(query.endDate)); d.setHours(23,59,59,999); filter.createdAt.$lte = d; }
    }
    return filter;
};

export const getAllPurchaseOrders = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as any);
    const [orders, total] = await Promise.all([
        purchaseOrderRepository.findMany(filter, { sort: '-createdAt', skip, limit }),
        purchaseOrderRepository.countDocuments(filter),
    ]);
    return res.status(StatusCodes.OK).json(customResponse({
        data: buildPaginatedResponse(orders.map(serializePurchaseOrder), total, page, limit),
        message: 'Lay danh sach don dat hang thanh cong',
        status: StatusCodes.OK, success: true,
    }));
};

export const getPurchaseOrderById = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    return res.status(StatusCodes.OK).json(customResponse({
        data: serializePurchaseOrder(order),
        message: 'Lay chi tiet don dat hang thanh cong',
        status: StatusCodes.OK, success: true,
    }));
};

export const createPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const { purchaseRequestIds, note } = req.body as { purchaseRequestIds: string[]; note?: string };

    // Validate phiáº¿u Ä‘á» xuáº¥t
    const requests = await PurchaseRequest.find({
        _id: { $in: purchaseRequestIds },
        isDeleted: { $ne: true },
    }).populate('plantId', 'name').lean();

    if (requests.length !== purchaseRequestIds.length) {
        throw new BadRequestError('Mot so phieu de xuat khong ton tai');
    }

    const invalidRequests = requests.filter((r: any) => r.status !== 'approved');
    if (invalidRequests.length) {
        throw new BadRequestError(
            `Cac phieu chua duoc duyet: ${invalidRequests.map((r: any) => r.requestCode).join(', ')}`
        );
    }

    // Kiá»ƒm tra phiáº¿u Ä‘Ã£ dÃ¹ng trong PO khÃ¡c chÆ°a
    const existingPO = await PurchaseOrder.findOne({
        purchaseRequestIds: { $in: purchaseRequestIds },
        status: { $ne: 'cancelled' },
        isDeleted: { $ne: true },
    }).lean();
    if (existingPO) {
        throw new BadRequestError('Mot so phieu de xuat da duoc su dung trong don dat hang khac');
    }

    // Gom items — populate plantId để lấy plantName
    const isValidId = (v: any) => v && v !== 'undefined' && v !== 'null' && String(v).length === 24;
    const allPlantIds = [...new Set([
        ...requests.map((r: any) => String(r.plantId?._id ?? r.plantId ?? '')).filter(isValidId),
        ...requests.flatMap((r: any) => (r.items ?? []).map((i: any) => String(i.plantId ?? '')).filter(isValidId)),
    ])];
    const Plant = (await import('@/models/Plant')).default;
    const plantDocs = await Plant.find({ _id: { $in: allPlantIds } }).select('name').lean();
    const plantNameMap = new Map(plantDocs.map((p: any) => [String(p._id), p.name as string]));

    // Gá»™p items
    const items: any[] = [];
    for (const req_ of requests as any[]) {
        const prPlantId = String(req_.plantId?._id ?? req_.plantId ?? '');
        const prPlantName = plantNameMap.get(prPlantId) || '';
        for (const item of req_.items ?? []) {
            const itemPlantId = isValidId(item.plantId) ? String(item.plantId) : '';
            const itemPlantName = itemPlantId ? (plantNameMap.get(itemPlantId) || prPlantName) : prPlantName;
            items.push(calcItem({
                purchaseRequestId: req_._id,
                purchaseRequestCode: req_.requestCode,
                materialId: item.materialId || undefined,
                materialName: item.materialName || '',
                unit: item.unit || '',
                quantityRequested: item.quantityRequested ?? 0,
                quantityOrdered: item.quantityOrdered ?? item.quantityRequested ?? 0,
                unitPrice: item.unitPrice ?? 0,
                vatRate: item.vatRate != null ? (item.vatRate > 1 ? item.vatRate : item.vatRate * 100) : 0,
                supplierId: item.supplierId || undefined,
                supplierName: item.supplierName || '',
                plantName: itemPlantName,
                proposedBy: item.proposedBy || '',
                purpose: item.purpose || '',
                note: item.note || '',
            }));
        }
    }

    const totals = calcTotals(items);
    const orderSupplier = deriveSingleSupplier(items);
    const orderCode = await generateDocumentCode({ model: PurchaseOrder, field: 'orderCode', prefix: 'PO' });

    const session = await mongoose.startSession();
    let createdId = '';
    try {
        await session.withTransaction(async () => {
            const order = await purchaseOrderRepository.create({
                orderCode,
                purchaseRequestIds: requests.map((r: any) => r._id),
                purchaseRequestCodes: requests.map((r: any) => r.requestCode),
                status: 'draft',
                items,
                supplierId: orderSupplier.supplierId,
                supplierName: orderSupplier.supplierName,
                ...totals,
                createdBy: req.userId,
                note: note?.trim() || undefined,
            }, session);
            createdId = String((order as any)._id);

            // Cáº­p nháº­t PurchaseRequest â†’ ordered
            await PurchaseRequest.updateMany(
                { _id: { $in: purchaseRequestIds } },
                { $set: { status: 'ordered' } },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    const created = await purchaseOrderRepository.findById(createdId);

    const actorName = await getActorName(req.userId);
    await notifyAdmins('notify:new', {
        type: 'info',
        actionType: 'purchase_order',
        actionId: createdId,
        title: 'Đơn đặt hàng mới',
        message: `${actorName} đã tạo đơn đặt hàng ${(created as any)?.orderCode || ''}`,
    });

    return res.status(StatusCodes.CREATED).json(customResponse({
        data: serializePurchaseOrder(created),
        message: 'Tao don dat hang thanh cong',
        status: StatusCodes.CREATED, success: true,
    }));
};

export const updatePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    if (!['draft', 'confirmed'].includes((order as any).status)) {
        throw new BadRequestError('Chi co the cap nhat don hang o trang thai nhap hoac da xac nhan');
    }

    const { items: itemUpdates, note } = req.body;
    let items = [...((order as any).items ?? [])].map((i: any) => (typeof i.toObject === 'function' ? i.toObject() : i));

    if (Array.isArray(itemUpdates)) {
        for (const upd of itemUpdates) {
            const idx = upd.index;
            if (idx < 0 || idx >= items.length) continue;
            const cur = { ...items[idx] };
            if (upd.quantityOrdered != null) cur.quantityOrdered = upd.quantityOrdered;
            if (upd.unitPrice != null) cur.unitPrice = upd.unitPrice;
            if (upd.vatRate != null) cur.vatRate = upd.vatRate;
            if (upd.supplierId != null) cur.supplierId = upd.supplierId;
            if (upd.supplierName != null) cur.supplierName = upd.supplierName;
            if (upd.note != null) cur.note = upd.note;
            items[idx] = calcItem(cur);
        }
    }

    const totals = calcTotals(items);
    const orderSupplier = deriveSingleSupplier(items);
    const updated = await purchaseOrderRepository.updateById(String(req.params.id), {
        items,
        supplierId: orderSupplier.supplierId,
        supplierName: orderSupplier.supplierName,
        ...totals,
        ...(note !== undefined ? { note: note?.trim() || undefined } : {}),
    });

    return res.status(StatusCodes.OK).json(customResponse({
        data: serializePurchaseOrder(updated),
        message: 'Cap nhat don dat hang thanh cong',
        status: StatusCodes.OK, success: true,
    }));
};

export const confirmPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    if ((order as any).status !== 'draft') throw new BadRequestError('Chi co the xac nhan don hang o trang thai nhap');

    const updated = await purchaseOrderRepository.updateById(String(req.params.id), {
        status: 'confirmed',
        orderedBy: req.userId,
        orderedAt: new Date(),
    });

    return res.status(StatusCodes.OK).json(customResponse({
        data: serializePurchaseOrder(updated),
        message: 'Xac nhan don dat hang thanh cong',
        status: StatusCodes.OK, success: true,
    }));
};

export const receivePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');

    const currentStatus = (order as any).status;
    if (!['confirmed', 'ordered'].includes(currentStatus)) {
        throw new BadRequestError(`Khong the nhan hang o trang thai: ${currentStatus}`);
    }

    if (!MAIN_PLANT_ID) throw new BadRequestError('Chua cau hinh MAIN_PLANT_ID');
    const CS1_PLANT_ID = new mongoose.Types.ObjectId(MAIN_PLANT_ID);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        for (const item of (order as any).items ?? []) {
            const qty = Number(item.quantityOrdered ?? item.quantityRequested ?? 0);
            if (qty <= 0) continue;

            // Resolve materialId: từ item hoặc lookup theo materialName
            let materialId: mongoose.Types.ObjectId | null = null;
            const rawId = toId(item.materialId);
            if (rawId && mongoose.Types.ObjectId.isValid(rawId)) {
                materialId = new mongoose.Types.ObjectId(rawId);
            } else if (item.materialName?.trim()) {
                const mat = await Material.findOne({
                    name: item.materialName.trim(),
                    isDeleted: { $ne: true },
                }).session(session).lean();
                if (mat) materialId = (mat as any)._id;
            }
            if (!materialId) continue; // không tìm được materialId → bỏ qua

            const existing = await (InventoryStock as any)
                .findOne({ materialId, plantId: CS1_PLANT_ID, isDeleted: { $ne: true } })
                .session(session);

            const stockBefore = Number(existing?.currentStock ?? 0);
            const stockAfter = stockBefore + qty;

            if (existing) {
                await (InventoryStock as any).updateOne(
                    { _id: existing._id },
                    { $set: { currentStock: stockAfter } },
                    { session }
                );
            } else {
                await (InventoryStock as any).create(
                    [{ materialId, plantId: CS1_PLANT_ID, currentStock: stockAfter }],
                    { session }
                );
            }

            await StockTransaction.create([{
                type: 'import',
                materialId,
                materialName: item.materialName,
                plantId: CS1_PLANT_ID,
                quantity: qty,
                stockBefore,
                stockAfter,
                relatedId: (order as any)._id,
                relatedType: 'purchase_order',
                performedBy: req.userId,
                note: `Nhan hang tu don ${(order as any).orderCode}`,
            }], { session });
        }

        await PurchaseOrder.updateOne(
            { _id: (order as any)._id },
            { $set: { status: 'received', receivedBy: req.userId, receivedAt: new Date() } },
            { session }
        );

        await PurchaseRequest.updateMany(
            { _id: { $in: (order as any).purchaseRequestIds } },
            { $set: { status: 'received' } },
            { session }
        );

        await session.commitTransaction();
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
    }

    const updated = await purchaseOrderRepository.findById(String(req.params.id));

    const actorName = await getActorName(req.userId);
    await notifyAdmins('notify:new', {
        type: 'success',
        actionType: 'purchase_order',
        actionId: String(req.params.id),
        title: 'Đã nhận hàng',
        message: `${actorName} đã xác nhận nhận hàng cho đơn ${(updated as any)?.orderCode || ''}`,
    });

    return res.status(StatusCodes.OK).json(customResponse({
        data: serializePurchaseOrder(updated),
        message: 'Nhan hang thanh cong, ton kho da cap nhat',
        status: StatusCodes.OK, success: true,
    }));
};

export const deletePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    if ((order as any).status !== 'draft') throw new BadRequestError('Chi co the huy don hang o trang thai nhap');

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await PurchaseOrder.updateOne(
                { _id: (order as any)._id },
                { $set: { isDeleted: true, deletedAt: new Date(), status: 'cancelled', cancelledBy: req.userId } },
                { session }
            );
            await PurchaseRequest.updateMany(
                { _id: { $in: (order as any).purchaseRequestIds } },
                { $set: { status: 'approved' } },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    return res.status(StatusCodes.OK).json(customResponse({
        data: null, message: 'Huy don dat hang thanh cong', status: StatusCodes.OK, success: true,
    }));
};

export const exportPurchaseOrderXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const { generatePurchaseOrderXlsx } = await import('@/utils/generatePurchaseOrderXlsx');
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');

    const data = serializePurchaseOrder(order);

    // Enrich plantName từ PR nếu item chưa có (dữ liệu cũ)
    const prIds = [...new Set((order as any).items?.map((i: any) => String(i.purchaseRequestId)).filter(Boolean) ?? [])];
    if (prIds.length) {
        const prs = await PurchaseRequest.find({ _id: { $in: prIds } })
            .populate('plantId', 'name')
            .populate('items.plantId', 'name')
            .lean();
        // Map prId → { prPlantName, itemPlantMap: Map<materialName, plantName> }
        const prInfoMap = new Map(prs.map((pr: any) => {
            const prPlantName = (pr.plantId as any)?.name || '';
            const itemPlantMap = new Map((pr.items ?? []).map((item: any) => [
                item.materialName,
                (item.plantId as any)?.name || prPlantName,
            ]));
            return [String(pr._id), { prPlantName, itemPlantMap }];
        }));

        data.items = (data.items ?? []).map((item: any) => {
            if (item.plantName) return item;
            const info = prInfoMap.get(String(item.purchaseRequestId));
            const plantName = info?.itemPlantMap.get(item.materialName) || info?.prPlantName || '';
            return { ...item, plantName };
        });
    }

    const buffer = await generatePurchaseOrderXlsx(data);
    const filename = `PhieuNhapHang_${data.orderCode ?? req.params.id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
};
