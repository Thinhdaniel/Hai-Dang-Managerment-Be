import { BadRequestError, NotFoundError } from '@/errors/customError';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseReceiptScan from '@/models/PurchaseReceiptScan';
import PurchaseRequest from '@/models/PurchaseRequest';
import PurchaseShortage from '@/models/PurchaseShortage';
import StockTransaction from '@/models/StockTransaction';
import { purchaseOrderRepository } from '@/repositories/purchase-order.repository';
import { ensurePlantExists, generateDocumentCode, getUserPlantId, toId } from '@/services/material-workflow.helpers';
import { notifyAdmins, getActorName } from '@/services/notification.helper';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializePurchaseOrder, serializePurchaseShortage } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const MAIN_PLANT_ID = process.env.MAIN_PLANT_ID || '';

const calcItem = (item: any) => {
    const qty = Number(item.quantityOrdered ?? 0);
    const price = Number(item.unitPrice ?? 0);
    const totalPrice = Number((qty * price).toFixed(2));
    const vatRate = Number(item.vatRate ?? 0);
    const vatAmount = Number(((totalPrice * vatRate) / 100).toFixed(2));
    const quantityReceived = Number(item.quantityReceived ?? 0);
    const quantityMissing = Math.max(0, Number((qty - quantityReceived).toFixed(2)));
    const receiveStatus = quantityReceived <= 0 ? 'pending' : quantityMissing > 0 ? 'partially_received' : 'received';
    return {
        ...item,
        quantityReceived,
        quantityMissing,
        receiveStatus,
        catalogStatus: item.catalogStatus || (item.materialId ? 'matched' : 'unmatched'),
        quantityInventoried: Number(item.quantityInventoried ?? 0),
        inventoryStatus: item.inventoryStatus || 'pending',
        totalPrice,
        vatAmount,
        totalWithVat: Number((totalPrice + vatAmount).toFixed(2)),
    };
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

const getOrderReceiveStatus = (items: any[], fallbackStatus = 'confirmed') => {
    const hasReceipt = items.some((item) => Number(item.quantityReceived ?? 0) > 0);
    if (!hasReceipt) return fallbackStatus;
    return items.every((item) => Number(item.quantityReceived ?? 0) >= Number(item.quantityOrdered ?? 0))
        ? 'received'
        : 'partially_received';
};

const getEffectiveOrderStatus = (order: any) => {
    if ((order as any)?.status === 'draft' && (order as any)?.orderedAt) {
        return 'ordered';
    }
    return (order as any)?.status;
};

const resolveMaterialForReceipt = async (item: any, session: mongoose.ClientSession) => {
    const rawId = toId(item.materialId);
    if (rawId && mongoose.Types.ObjectId.isValid(rawId)) {
        return Material.findOne({
            _id: rawId,
            isDeleted: { $ne: true },
        })
            .session(session)
            .lean();
    }

    return null;
};

const getOrderPlantId = (order: any) => {
    const plantId = toId(order.plantId) || MAIN_PLANT_ID;
    if (!plantId) {
        throw new BadRequestError('Chua cau hinh co so nhan hang');
    }
    return new mongoose.Types.ObjectId(plantId);
};

const applyReceiptStock = async ({
    item,
    quantity,
    plantId,
    order,
    performedBy,
    note,
    session,
}: {
    item: any;
    quantity: number;
    plantId: mongoose.Types.ObjectId;
    order: any;
    performedBy?: string;
    note: string;
    session: mongoose.ClientSession;
}) => {
    const material = await resolveMaterialForReceipt(item, session);
    if (!material) {
        return { applied: false, reason: 'not_catalog_item', materialId: null };
    }

    if ((material as any).trackInventory === false) {
        return { applied: false, reason: 'material_not_tracked', materialId: (material as any)._id };
    }

    const materialId = (material as any)._id;

    const existing = await (InventoryStock as any)
        .findOne({ materialId, plantId, isDeleted: { $ne: true } })
        .session(session);

    const stockBefore = Number(existing?.currentStock ?? 0);
    const stockAfter = stockBefore + quantity;

    if (existing) {
        await (InventoryStock as any).updateOne(
            { _id: existing._id },
            { $set: { currentStock: stockAfter } },
            { session }
        );
    } else {
        await (InventoryStock as any).create([{ materialId, plantId, currentStock: stockAfter }], { session });
    }

    await StockTransaction.create(
        [
            {
                type: 'import',
                materialId,
                materialName: item.materialName,
                plantId,
                quantity,
                stockBefore,
                stockAfter,
                relatedId: order._id,
                relatedType: 'purchase_order',
                performedBy,
                note,
            },
        ],
        { session }
    );

    return { applied: true, reason: undefined, materialId };
};

const applyPendingInventoryForItem = async ({
    order,
    item,
    session,
    performedBy,
}: {
    order: any;
    item: any;
    session: mongoose.ClientSession;
    performedBy?: string;
}) => {
    if (item.catalogStatus === 'ignored') {
        item.inventoryStatus = 'skipped';
        item.inventorySkipReason = item.inventorySkipReason || 'ignored';
        return item;
    }

    const received = Number(item.quantityReceived ?? 0);
    const inventoried = Number(item.quantityInventoried ?? 0);
    const pendingQuantity = Number(Math.max(0, received - inventoried).toFixed(2));
    if (pendingQuantity <= 0) {
        item.inventoryStatus = received > 0 ? 'applied' : item.inventoryStatus || 'pending';
        return item;
    }

    const result = await applyReceiptStock({
        item,
        quantity: pendingQuantity,
        plantId: getOrderPlantId(order),
        order,
        performedBy,
        note: `Nhap ton tu don ${(order as any).orderCode}`,
        session,
    });

    if (result.applied) {
        item.materialId = item.materialId || result.materialId;
        item.quantityInventoried = Number((inventoried + pendingQuantity).toFixed(2));
        item.inventoryStatus = item.quantityInventoried >= received ? 'applied' : 'pending';
        item.inventorySkipReason = undefined;
    } else {
        item.inventoryStatus = result.reason === 'material_not_tracked' ? 'skipped' : 'pending';
        item.inventorySkipReason = result.reason;
    }

    return item;
};

const upsertShortageForItem = async ({
    order,
    item,
    itemIndex,
    session,
}: {
    order: any;
    item: any;
    itemIndex: number;
    session: mongoose.ClientSession;
}) => {
    const quantityMissing = Math.max(0, Number(item.quantityMissing ?? 0));
    const existing = await PurchaseShortage.findOne({
        originalPurchaseOrderId: order._id,
        originalItemIndex: itemIndex,
        isDeleted: { $ne: true },
    }).session(session);

    if (quantityMissing <= 0) {
        if (existing && existing.status !== 'settled') {
            const previousMissing = Number(existing.quantityMissing ?? 0);
            existing.quantityMissing = Math.max(previousMissing, Number(existing.quantityResolved ?? 0));
            existing.quantityResolved = existing.quantityMissing;
            existing.status = 'settled';
            await existing.save({ session });
        }
        return;
    }

    const quantityResolved = Number(existing?.quantityResolved ?? 0);
    const status =
        quantityResolved <= 0 ? 'outstanding' : quantityResolved < quantityMissing ? 'partially_settled' : 'settled';
    const payload = {
        originalPurchaseOrderId: order._id,
        originalPurchaseOrderCode: order.orderCode,
        originalItemIndex: itemIndex,
        supplierId: item.supplierId || undefined,
        supplierName: item.supplierName || undefined,
        materialId: item.materialId || undefined,
        materialName: item.materialName || '',
        unit: item.unit || '',
        quantityMissing,
        status,
    };

    if (existing) {
        existing.set(payload);
        await existing.save({ session });
        return;
    }

    await PurchaseShortage.create([payload], { session });
};

const syncOriginalOrderAfterShortageResolution = async ({
    shortage,
    quantity,
    session,
}: {
    shortage: any;
    quantity: number;
    session: mongoose.ClientSession;
}) => {
    const originalOrder = await PurchaseOrder.findOne({
        _id: shortage.originalPurchaseOrderId,
        isDeleted: { $ne: true },
    }).session(session);
    if (!originalOrder) return;

    const items = [...((originalOrder as any).items ?? [])].map((item: any) =>
        typeof item.toObject === 'function' ? item.toObject() : item
    );
    const index = Number(shortage.originalItemIndex);
    if (index < 0 || index >= items.length) return;

    const item = { ...items[index] };
    const ordered = Number(item.quantityOrdered ?? 0);
    const currentReceived = Number(item.quantityReceived ?? 0);
    item.quantityReceived = Math.min(ordered, currentReceived + quantity);
    item.quantityMissing = Math.max(0, Number((ordered - item.quantityReceived).toFixed(2)));
    item.receiveStatus =
        item.quantityReceived <= 0 ? 'pending' : item.quantityMissing > 0 ? 'partially_received' : 'received';
    items[index] = item;

    const status = getOrderReceiveStatus(items, getEffectiveOrderStatus(originalOrder));
    await PurchaseOrder.updateOne({ _id: (originalOrder as any)._id }, { $set: { items, status } }, { session });

    if (status === 'received') {
        await PurchaseRequest.updateMany(
            { _id: { $in: (originalOrder as any).purchaseRequestIds } },
            { $set: { status: 'received' } },
            { session }
        );
    }
};

const buildFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const andConditions: Record<string, any>[] = [];
    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });
    if (regex) {
        andConditions.push({
            $or: [{ orderCode: regex }, { 'items.materialName': regex }, { 'items.supplierName': regex }],
        });
    }
    if (query.status === 'draft') {
        andConditions.push({ status: 'draft' }, { $or: [{ orderedAt: { $exists: false } }, { orderedAt: null }] });
    } else if (query.status === 'ordered') {
        andConditions.push({ $or: [{ status: 'ordered' }, { status: 'draft', orderedAt: { $ne: null } }] });
    } else if (query.status) {
        filter.status = query.status;
    }
    if (andConditions.length) filter.$and = andConditions;
    if (query.plantId) filter.plantId = query.plantId;
    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) filter.createdAt.$gte = new Date(String(query.startDate));
        if (query.endDate) {
            const d = new Date(String(query.endDate));
            d.setHours(23, 59, 59, 999);
            filter.createdAt.$lte = d;
        }
    }
    if (req.role !== 'admin') {
        filter.plantId = getUserPlantId(req);
    }
    return filter;
};

export const getAllPurchaseOrders = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as any);
    const [orders, total] = await Promise.all([
        purchaseOrderRepository.findMany(filter, { sort: '-createdAt', skip, limit }),
        purchaseOrderRepository.countDocuments(filter),
    ]);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(orders.map(serializePurchaseOrder), total, page, limit),
            message: 'Lay danh sach don dat hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPurchaseOrderById = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseOrder(order),
            message: 'Lay chi tiet don dat hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getOutstandingPurchaseShortages = async (req: Request, res: Response, next: NextFunction) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (req.query.status === 'open' || !req.query.status) {
        filter.status = { $in: ['outstanding', 'partially_settled'] };
    } else {
        filter.status = req.query.status;
    }

    if (req.query.supplierId) {
        filter.supplierId = req.query.supplierId;
    }

    if (req.query.materialId) {
        filter.materialId = req.query.materialId;
    }

    const shortages = await PurchaseShortage.find(filter)
        .sort('-createdAt')
        .limit(Number(req.query.limit ?? 200));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: shortages.map(serializePurchaseShortage),
            message: 'Lay danh sach no hang nha cung cap thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const { purchaseRequestIds, note } = req.body as { purchaseRequestIds: string[]; note?: string };

    // Validate phiáº¿u Ä‘á» xuáº¥t
    const requests = await PurchaseRequest.find({
        _id: { $in: purchaseRequestIds },
        isDeleted: { $ne: true },
    })
        .populate('plantId', 'name')
        .lean();

    if (requests.length !== purchaseRequestIds.length) {
        throw new BadRequestError('Mot so phieu de xuat khong ton tai');
    }

    const invalidRequests = requests.filter((r: any) => r.status !== 'approved');
    if (invalidRequests.length) {
        throw new BadRequestError(
            `Cac phieu chua duoc duyet: ${invalidRequests.map((r: any) => r.requestCode).join(', ')}`
        );
    }

    const requestPlantIds = [
        ...new Set(requests.map((r: any) => String(r.plantId?._id ?? r.plantId ?? '')).filter(Boolean)),
    ];
    if (requestPlantIds.length !== 1) {
        throw new BadRequestError('Chi co the tao don hang tu cac phieu cung mot co so');
    }
    const orderPlantId = requestPlantIds[0];
    await ensurePlantExists(orderPlantId);
    if (req.role !== 'admin' && getUserPlantId(req) !== orderPlantId) {
        throw new BadRequestError('Ban chi co the tao don hang cho co so cua minh');
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
    const allPlantIds = [
        ...new Set([
            ...requests.map((r: any) => String(r.plantId?._id ?? r.plantId ?? '')).filter(isValidId),
            ...requests.flatMap((r: any) => (r.items ?? []).map((i: any) => String(i.plantId ?? '')).filter(isValidId)),
        ]),
    ];
    const Plant = (await import('@/models/Plant')).default;
    const plantDocs = await Plant.find({ _id: { $in: allPlantIds } })
        .select('name')
        .lean();
    const plantNameMap = new Map(plantDocs.map((p: any) => [String(p._id), p.name as string]));

    // Gá»™p items
    const items: any[] = [];
    for (const req_ of requests as any[]) {
        const prPlantId = String(req_.plantId?._id ?? req_.plantId ?? '');
        const prPlantName = plantNameMap.get(prPlantId) || '';
        for (const [itemIndex, item] of (req_.items ?? []).entries()) {
            const itemPlantId = isValidId(item.plantId) ? String(item.plantId) : '';
            const itemPlantName = itemPlantId ? plantNameMap.get(itemPlantId) || prPlantName : prPlantName;
            const quantityRequested = item.quantityRequested ?? 0;
            const quantityOrdered = item.quantityOrdered ?? item.quantityRequested ?? 0;
            items.push(
                calcItem({
                    purchaseRequestId: req_._id,
                    purchaseRequestCode: req_.requestCode,
                    sourceLines: [
                        {
                            purchaseRequestId: req_._id,
                            purchaseRequestCode: req_.requestCode,
                            requestItemIndex: itemIndex,
                            materialId: item.materialId || undefined,
                            materialName: item.materialName || '',
                            unit: item.unit || '',
                            plantId: itemPlantId || prPlantId || undefined,
                            plantName: itemPlantName,
                            proposedBy: item.proposedBy || '',
                            purpose: item.purpose || '',
                            quantityRequested,
                            quantityOrdered,
                        },
                    ],
                    materialId: item.materialId || undefined,
                    materialName: item.materialName || '',
                    unit: item.unit || '',
                    quantityRequested,
                    quantityOrdered,
                    quantityReceived: item.quantityReceived ?? 0,
                    unitPrice: item.unitPrice ?? 0,
                    vatRate: item.vatRate != null ? (item.vatRate > 1 ? item.vatRate : item.vatRate * 100) : 0,
                    supplierId: item.supplierId || undefined,
                    supplierName: item.supplierName || '',
                    plantId: itemPlantId || prPlantId || undefined,
                    plantName: itemPlantName,
                    proposedBy: item.proposedBy || '',
                    purpose: item.purpose || '',
                    catalogStatus: item.catalogStatus || (item.materialId ? 'matched' : 'unmatched'),
                    quantityInventoried: 0,
                    inventoryStatus: item.materialId ? 'pending' : 'pending',
                    note: item.note || '',
                })
            );
        }
    }

    const totals = calcTotals(items);
    const orderSupplier = deriveSingleSupplier(items);
    const orderCode = await generateDocumentCode({ model: PurchaseOrder, field: 'orderCode', prefix: 'PO' });

    const session = await mongoose.startSession();
    let createdId = '';
    try {
        await session.withTransaction(async () => {
            const order = await purchaseOrderRepository.create(
                {
                    orderCode,
                    plantId: orderPlantId,
                    purchaseRequestIds: requests.map((r: any) => r._id),
                    purchaseRequestCodes: requests.map((r: any) => r.requestCode),
                    status: 'draft',
                    items,
                    supplierId: orderSupplier.supplierId,
                    supplierName: orderSupplier.supplierName,
                    ...totals,
                    createdBy: req.userId,
                    note: note?.trim() || undefined,
                },
                session
            );
            createdId = String((order as any)._id);

            // Gan phieu de xuat vao PO nhap; chi chuyen sang ordered sau khi giam doc xac nhan PO.
            await PurchaseRequest.updateMany(
                { _id: { $in: purchaseRequestIds } },
                { $set: { status: 'in_progress' } },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    const created = await purchaseOrderRepository.findById(createdId);

    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'info',
            actionType: 'purchase_order',
            actionId: createdId,
            title: 'Đơn đặt hàng mới',
            message: `${actorName} đã tạo đơn đặt hàng ${(created as any)?.orderCode || ''}`,
        },
        { excludeUserIds: [req.userId] }
    );

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializePurchaseOrder(created),
            message: 'Tao don dat hang thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updatePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);
    if (!['draft', 'confirmed'].includes(getEffectiveOrderStatus(order))) {
        throw new BadRequestError('Chi co the cap nhat don hang o trang thai nhap hoac da xac nhan');
    }

    const { items: itemUpdates, note } = req.body;
    const items = [...((order as any).items ?? [])].map((i: any) =>
        typeof i.toObject === 'function' ? i.toObject() : i
    );

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

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseOrder(updated),
            message: 'Cap nhat don dat hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const confirmPurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);
    if (getEffectiveOrderStatus(order) !== 'draft') {
        throw new BadRequestError('Chi co the xac nhan don hang o trang thai nhap');
    }

    const session = await mongoose.startSession();
    let updated: any;
    try {
        await session.withTransaction(async () => {
            updated = await purchaseOrderRepository.updateById(
                String(req.params.id),
                {
                    status: 'ordered',
                    orderedBy: req.userId,
                    orderedAt: new Date(),
                },
                session
            );

            await PurchaseRequest.updateMany(
                { _id: { $in: (order as any).purchaseRequestIds }, isDeleted: { $ne: true } },
                { $set: { status: 'ordered' } },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseOrder(updated),
            message: 'Xac nhan don dat hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const receivePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);

    const currentStatus = getEffectiveOrderStatus(order);
    if (!['confirmed', 'ordered', 'partially_received'].includes(currentStatus)) {
        throw new BadRequestError(`Khong the nhan hang o trang thai: ${currentStatus}`);
    }

    const receivingPlantId = getOrderPlantId(order);
    const receiptItems = Array.isArray(req.body.items) ? req.body.items : [];
    const shortageAllocations = Array.isArray(req.body.shortageAllocations) ? req.body.shortageAllocations : [];
    const receiptScanId = req.body.receiptScanId;

    if (!receiptItems.length && !shortageAllocations.length) {
        throw new BadRequestError('Phai nhap it nhat mot dong nhan hang hoac hang bu');
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const items = [...((order as any).items ?? [])].map((item: any) =>
            typeof item.toObject === 'function' ? item.toObject() : item
        );

        for (const receiptItem of receiptItems) {
            const index = Number(receiptItem.index);
            if (index < 0 || index >= items.length) {
                throw new BadRequestError(`Dong nhan hang ${index} khong hop le`);
            }

            const quantity = Number(receiptItem.quantityReceived ?? 0);
            const shouldMarkShortage = Boolean(receiptItem.markShortage);
            if (quantity <= 0 && !shouldMarkShortage) continue;
            const item = { ...items[index] };
            const ordered = Number(item.quantityOrdered ?? item.quantityRequested ?? 0);
            const alreadyReceived = Number(item.quantityReceived ?? 0);
            const remaining = Math.max(0, ordered - alreadyReceived);

            if (quantity > remaining) {
                throw new BadRequestError(`So luong nhan cua "${item.materialName}" vuot qua so luong con lai`);
            }

            if (quantity > 0) {
                const inventoryResult = await applyReceiptStock({
                    item,
                    quantity,
                    plantId: receivingPlantId,
                    order,
                    performedBy: req.userId,
                    note: `Nhan hang tu don ${(order as any).orderCode}`,
                    session,
                });
                if (inventoryResult.applied) {
                    item.materialId = item.materialId || inventoryResult.materialId;
                    item.quantityInventoried = Number((Number(item.quantityInventoried ?? 0) + quantity).toFixed(2));
                    item.inventoryStatus = 'applied';
                    item.inventorySkipReason = undefined;
                } else {
                    item.inventoryStatus = inventoryResult.reason === 'material_not_tracked' ? 'skipped' : 'pending';
                    item.inventorySkipReason = inventoryResult.reason;
                }
            }

            item.quantityReceived = Number((alreadyReceived + quantity).toFixed(2));
            item.quantityMissing = Math.max(0, Number((ordered - item.quantityReceived).toFixed(2)));
            item.receiveStatus =
                item.quantityReceived <= 0 ? 'pending' : item.quantityMissing > 0 ? 'partially_received' : 'received';
            items[index] = item;

            await upsertShortageForItem({ order, item, itemIndex: index, session });
        }

        for (const allocation of shortageAllocations) {
            const quantity = Number(allocation.quantityReceived ?? 0);
            if (quantity <= 0) continue;

            const shortage = await PurchaseShortage.findOne({
                _id: allocation.shortageId,
                isDeleted: { $ne: true },
                status: { $in: ['outstanding', 'partially_settled'] },
            }).session(session);

            if (!shortage) {
                throw new NotFoundError('Khong tim thay no hang nha cung cap');
            }

            const outstanding = Number(shortage.quantityMissing ?? 0) - Number(shortage.quantityResolved ?? 0);
            if (quantity > outstanding) {
                throw new BadRequestError(`So luong bu cho "${shortage.materialName}" vuot qua so luong con no`);
            }

            await applyReceiptStock({
                item: shortage,
                quantity,
                plantId: receivingPlantId,
                order,
                performedBy: req.userId,
                note: `Hang bu cho don ${shortage.originalPurchaseOrderCode || ''}`,
                session,
            });

            shortage.quantityResolved = Number((Number(shortage.quantityResolved ?? 0) + quantity).toFixed(2));
            shortage.status =
                shortage.quantityResolved >= Number(shortage.quantityMissing ?? 0)
                    ? 'settled'
                    : shortage.quantityResolved > 0
                      ? 'partially_settled'
                      : 'outstanding';
            shortage.resolutions.push({
                purchaseOrderId: (order as any)._id,
                purchaseOrderCode: (order as any).orderCode,
                quantity,
                resolvedBy: req.userId,
                resolvedAt: req.body.receivedAt ? new Date(req.body.receivedAt) : new Date(),
                note: allocation.note?.trim() || req.body.note?.trim() || undefined,
            } as any);
            await shortage.save({ session });

            await syncOriginalOrderAfterShortageResolution({ shortage, quantity, session });
        }

        const nextStatus = getOrderReceiveStatus(items, currentStatus);
        await PurchaseOrder.updateOne(
            { _id: (order as any)._id },
            {
                $set: {
                    items,
                    status: nextStatus,
                    receivedBy: req.userId,
                    receivedAt: req.body.receivedAt ? new Date(req.body.receivedAt) : new Date(),
                },
            },
            { session }
        );

        if (receiptScanId) {
            const scanUpdate = await PurchaseReceiptScan.updateOne(
                {
                    _id: receiptScanId,
                    purchaseOrderId: (order as any)._id,
                    status: { $in: ['preview', 'applied'] },
                },
                {
                    $set: {
                        status: 'applied',
                        appliedBy: req.userId,
                        appliedAt: req.body.receivedAt ? new Date(req.body.receivedAt) : new Date(),
                        appliedPayload: {
                            items: receiptItems,
                            shortageAllocations,
                            receivedAt: req.body.receivedAt,
                            note: req.body.note,
                        },
                    },
                },
                { session }
            );
            if (!scanUpdate.matchedCount) {
                throw new BadRequestError('Lan quet phieu nhan hang khong hop le');
            }
        }

        if (nextStatus === 'received') {
            await PurchaseRequest.updateMany(
                { _id: { $in: (order as any).purchaseRequestIds } },
                { $set: { status: 'received' } },
                { session }
            );
        }

        await session.commitTransaction();
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
    }

    const updated = await purchaseOrderRepository.findById(String(req.params.id));

    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'success',
            actionType: 'purchase_order',
            actionId: String(req.params.id),
            title: 'Đã nhận hàng',
            message: `${actorName} đã xác nhận nhận hàng cho đơn ${(updated as any)?.orderCode || ''}`,
        },
        { excludeUserIds: [req.userId] }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseOrder(updated),
            message: 'Nhan hang thanh cong, ton kho da cap nhat',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deletePurchaseOrder = async (req: Request, res: Response, next: NextFunction) => {
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);
    if (getEffectiveOrderStatus(order) !== 'draft')
        throw new BadRequestError('Chi co the huy don hang o trang thai nhap');

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

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Huy don dat hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const getMutableOrderItem = (order: any, indexParam: string) => {
    const index = Number(indexParam);
    if (!Number.isInteger(index) || index < 0 || index >= ((order as any).items?.length ?? 0)) {
        throw new BadRequestError('Dong vat tu khong hop le');
    }

    const items = [...((order as any).items ?? [])].map((item: any) =>
        typeof item.toObject === 'function' ? item.toObject() : item
    );

    return { index, items, item: { ...items[index] } };
};

const ensureOrderMutationScope = (req: Request, order: any) => {
    if (req.role === 'admin') return;
    const userPlantId = getUserPlantId(req);
    const orderPlantId = toId(order.plantId) || MAIN_PLANT_ID;
    if (!userPlantId || userPlantId !== orderPlantId) {
        throw new BadRequestError('Ban chi co the cap nhat don hang cua co so minh');
    }
};

const syncPurchaseRequestCatalogItem = async ({
    item,
    material,
    session,
}: {
    item: any;
    material: any;
    session: mongoose.ClientSession;
}) => {
    if (!item.purchaseRequestId) return;
    await PurchaseRequest.updateOne(
        {
            _id: item.purchaseRequestId,
            'items.materialName': item.materialName,
        },
        {
            $set: {
                'items.$.materialId': material._id,
                'items.$.materialName': material.name,
                'items.$.unit': material.unit,
                'items.$.catalogStatus': 'matched',
            },
        },
        { session }
    );
};

export const linkPurchaseOrderItemMaterial = async (req: Request, res: Response, next: NextFunction) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('Don hang khong hop le');
    const session = await mongoose.startSession();
    let updatedId = '';

    try {
        await session.withTransaction(async () => {
            const order = await PurchaseOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).session(
                session
            );
            if (!order) throw new NotFoundError('Khong tim thay don dat hang');
            ensureOrderMutationScope(req, order);

            const material = await Material.findOne({
                _id: req.body.materialId,
                isDeleted: { $ne: true },
                isActive: { $ne: false },
            }).session(session);
            if (!material) throw new NotFoundError('Khong tim thay vat tu');

            const { index, items, item } = getMutableOrderItem(order, String(req.params.index));
            item.materialId = material._id;
            item.materialName = material.name;
            item.unit = material.unit;
            item.catalogStatus = 'matched';
            item.inventorySkipReason = undefined;
            await syncPurchaseRequestCatalogItem({ item: items[index], material, session });
            items[index] = await applyPendingInventoryForItem({ order, item, session, performedBy: req.userId });

            await PurchaseOrder.updateOne({ _id: order._id }, { $set: { items } }, { session });
            updatedId = String(order._id);
        });
    } finally {
        await session.endSession();
    }

    const updated = await purchaseOrderRepository.findById(updatedId);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseOrder(updated),
            message: 'Da gan vat tu vao danh muc',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createMaterialForPurchaseOrderItem = async (req: Request, res: Response, next: NextFunction) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('Don hang khong hop le');
    const session = await mongoose.startSession();
    let updatedId = '';

    try {
        await session.withTransaction(async () => {
            const order = await PurchaseOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).session(
                session
            );
            if (!order) throw new NotFoundError('Khong tim thay don dat hang');
            ensureOrderMutationScope(req, order);

            const { index, items, item } = getMutableOrderItem(order, String(req.params.index));
            const code = req.body.code?.trim();
            if (code) {
                const duplicated = await Material.findOne({ code, isDeleted: { $ne: true } }).session(session);
                if (duplicated) throw new BadRequestError('Ma vat tu da ton tai');
            }

            const name = req.body.name?.trim() || item.materialName?.trim();
            const unit = req.body.unit?.trim() || item.unit?.trim();
            if (!name) throw new BadRequestError('Ten vat tu khong duoc de trong');
            if (!unit) throw new BadRequestError('Don vi tinh khong duoc de trong');

            const material = await Material.create(
                [
                    {
                        code: code || undefined,
                        name,
                        unit,
                        category: req.body.category?.trim() || undefined,
                        description: req.body.description?.trim() || undefined,
                        minStockLevel: Number(req.body.minStockLevel ?? 0),
                        trackInventory: req.body.trackInventory !== false,
                        createdBy: req.userId,
                        updatedBy: req.userId,
                    },
                ],
                { session }
            ).then((rows) => rows[0]);

            item.materialId = material._id;
            item.materialName = material.name;
            item.unit = material.unit;
            item.catalogStatus = 'matched';
            item.inventorySkipReason = undefined;
            await syncPurchaseRequestCatalogItem({ item: items[index], material, session });
            items[index] = await applyPendingInventoryForItem({ order, item, session, performedBy: req.userId });

            await PurchaseOrder.updateOne({ _id: order._id }, { $set: { items } }, { session });
            updatedId = String(order._id);
        });
    } finally {
        await session.endSession();
    }

    const updated = await purchaseOrderRepository.findById(updatedId);
    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializePurchaseOrder(updated),
            message: 'Da tao vat tu va gan vao don hang',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const ignorePurchaseOrderItemInventory = async (req: Request, res: Response, next: NextFunction) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('Don hang khong hop le');
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);

    const { index, items, item } = getMutableOrderItem(order, String(req.params.index));
    item.catalogStatus = 'ignored';
    item.inventoryStatus = 'skipped';
    item.inventorySkipReason = req.body.reason?.trim() || 'ignored';
    items[index] = item;

    const updated = await purchaseOrderRepository.updateById(String(req.params.id), { items });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseOrder(updated),
            message: 'Da bo qua quan ton cho dong vat tu',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

/** Xuất Excel TỔNG HỢP đặt hàng theo khoảng thời gian (startDate/endDate) — 4 sheet. */
export const exportRangePurchaseOrdersXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query, req);
    // Mặc định loại đơn đã hủy khỏi báo cáo (trừ khi lọc đích danh)
    if (!req.query.status) filter.status = { $ne: 'cancelled' };

    const orders = await purchaseOrderRepository.findMany(filter, { sort: 'createdAt' });
    if (!orders.length) throw new BadRequestError('Khong co don dat hang nao trong khoang thoi gian nay');

    const plains = orders.map(serializePurchaseOrder);
    const orderIds = orders.map((order: any) => String(order._id));
    const shortages = await PurchaseShortage.find({
        originalPurchaseOrderId: { $in: orderIds },
        isDeleted: { $ne: true },
    }).lean();

    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const label = startDate && endDate ? `${startDate} den ${endDate}` : startDate || endDate || 'Tat ca';

    const { generateRangePurchaseOrdersXlsx } = await import('@/utils/generateRangePurchaseOrdersXlsx');
    const buffer = await generateRangePurchaseOrdersXlsx(plains, shortages, label);

    const filename = `dat-hang-${label.replace(/[/\s]+/g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer as ArrayBuffer));
};

export const exportPurchaseOrderXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const { generatePurchaseOrderXlsx } = await import('@/utils/generatePurchaseOrderXlsx');
    const order = await purchaseOrderRepository.findById(String(req.params.id));
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderMutationScope(req, order);

    const data = serializePurchaseOrder(order);

    // Enrich plantName từ PR nếu item chưa có (dữ liệu cũ)
    const prIds = [
        ...new Set((order as any).items?.map((i: any) => String(i.purchaseRequestId)).filter(Boolean) ?? []),
    ];
    if (prIds.length) {
        const prs = await PurchaseRequest.find({ _id: { $in: prIds } })
            .populate('plantId', 'name')
            .populate('items.plantId', 'name')
            .lean();
        // Map prId → { prPlantName, itemPlantMap: Map<materialName, plantName> }
        const prInfoMap = new Map(
            prs.map((pr: any) => {
                const prPlantName = (pr.plantId as any)?.name || '';
                const itemPlantMap = new Map(
                    (pr.items ?? []).map((item: any) => [item.materialName, (item.plantId as any)?.name || prPlantName])
                );
                return [String(pr._id), { prPlantName, itemPlantMap }];
            })
        );

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
