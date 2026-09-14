import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionItem from '@/models/ProductionItem';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionOpeningBalanceBatch from '@/models/ProductionOpeningBalanceBatch';
import ProductionMaterialReservation from '@/models/ProductionMaterialReservation';
import ProductionOrder from '@/models/ProductionOrder';
import ProductionPlan from '@/models/ProductionPlan';
import { vietnamIsoDate } from '@/utils/vietnamDate';
import ExcelJS from 'exceljs';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import {
    PRODUCTION_ORDER_STATUSES,
    isRecognizedProductionOrderPriority,
    isRecognizedProductionOrderStatus,
    normalizeProductionOrderCode,
    normalizeProductionOrderHeader,
    parseProductionOrderDate,
    parseProductionOrderPriority,
    parseProductionOrderStatus,
    productionOrderDeadlineStatus,
    summarizeProductionOrderProgress,
    type ProductionOrderPriority,
    type ProductionOrderStatus,
} from './production-order.helpers';
import { resolveProductionOrderLifecycleStatus } from './production-control-tower.helpers';
import { sendSuccess } from './service.helpers';

const ACTOR_SELECT = 'fullname username email';
const ORDER_POPULATE = [
    { path: 'createdBy', select: ACTOR_SELECT },
    { path: 'updatedBy', select: ACTOR_SELECT },
    { path: 'history.actor', select: ACTOR_SELECT },
] as const;
const OPEN_STATUSES: ProductionOrderStatus[] = ['draft', 'ready', 'in_production', 'paused'];
const STATUS_TRANSITIONS: Record<ProductionOrderStatus, ProductionOrderStatus[]> = {
    draft: ['ready', 'cancelled'],
    ready: ['draft', 'in_production', 'paused', 'cancelled'],
    in_production: ['paused', 'completed', 'cancelled'],
    paused: ['ready', 'in_production', 'completed', 'cancelled'],
    completed: ['in_production'],
    cancelled: ['draft'],
};

type OrderProgress = ReturnType<typeof summarizeProductionOrderProgress> & {
    lastProductionDate?: string;
    activeLineCodes: string[];
    deadlineStatus: ReturnType<typeof productionOrderDeadlineStatus>['code'];
    daysRemaining: number;
};

type ImportRow = {
    rowNumber: number;
    code: string;
    customerName?: string;
    itemId?: string;
    itemCode: string;
    itemName?: string;
    totalQuantity: number;
    plannedStartDate?: string;
    dueDate?: string;
    priority: ProductionOrderPriority;
    status: ProductionOrderStatus;
    note?: string;
    action: 'create' | 'update' | 'error';
    existingId?: string;
    errors: string[];
};

const toId = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const actorName = (value: any) => value?.fullname || value?.username || value?.email || undefined;
const serializeActor = (value: any) => {
    const id = toId(value);
    return id ? { id, name: actorName(value) } : undefined;
};
const toIso = (value: any) => (value ? new Date(value).toISOString() : undefined);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền quản lý đơn hàng của cơ sở này');
    }
};

const resolvePlant = async (req: Request, input?: unknown) => {
    const plantId = String(input || userPlantId(req) || '');
    if (!plantId) throw new BadRequestError('Cần chọn cơ sở');
    assertPlantAccess(req, plantId);
    const plant: any = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: String(plant._id), name: plant.name, code: plant.code || '' };
};

const populateOrder = async (order: any) => {
    await order.populate(ORDER_POPULATE as any);
    return order;
};

const orderKey = (value: unknown) => normalizeProductionOrderCode(value);

export const buildProductionOrderProgress = async (
    plantId: string,
    orders: any[]
): Promise<Map<string, OrderProgress>> => {
    const result = new Map<string, any>();
    const byId = new Map<string, string>();
    const byCode = new Map<string, string>();
    orders.forEach((order) => {
        const id = String(order._id || order.id);
        const code = orderKey(order.code);
        byId.set(id, id);
        byCode.set(code, id);
        result.set(id, {
            totalQuantity: Number(order.totalQuantity || 0),
            openingQuantity: 0,
            trackedQuantity: 0,
            futurePlannedQuantity: 0,
            trackedByDate: new Map<string, number>(),
            activeLineCodes: new Set<string>(),
            lastProductionDate: undefined,
        });
    });
    if (!orders.length) return new Map();

    const ids = [...byId.keys()].map((id) => new mongoose.Types.ObjectId(id));
    const codes = [...byCode.keys()];
    const [openingBatches, records, plans]: [any[], any[], any[]] = await Promise.all([
        ProductionOpeningBalanceBatch.find({ plantId, status: 'confirmed', 'entries.orderCode': { $in: codes } })
            .select('cutoffDate entries')
            .lean(),
        ProductionLineRecord.find({
            plantId,
            $or: [{ 'runs.orderId': { $in: ids } }, { 'runs.orderCode': { $in: codes } }],
        })
            .select('productionDate lineCode runs entries')
            .lean(),
        ProductionPlan.find({
            plantId,
            status: 'published',
            productionDate: { $gte: vietnamIsoDate() },
            $or: [{ 'allocations.orderId': { $in: ids } }, { 'allocations.orderCode': { $in: codes } }],
        })
            .select('productionDate allocations')
            .lean(),
    ]);

    const cutoffDate = openingBatches[0]?.cutoffDate ? String(openingBatches[0].cutoffDate) : undefined;
    const resolveReference = (source: any) => {
        const direct = source.orderId ? byId.get(String(source.orderId)) : undefined;
        return direct || byCode.get(orderKey(source.orderCode));
    };

    openingBatches.forEach((batch) => {
        (batch.entries || []).forEach((entry: any) => {
            const id = byCode.get(orderKey(entry.orderCode));
            if (id) result.get(id).openingQuantity += Number(entry.quantity || 0);
        });
    });

    records.forEach((record) => {
        if (cutoffDate && String(record.productionDate) <= cutoffDate) return;
        const runOrder = new Map<string, string>();
        (record.runs || []).forEach((run: any) => {
            const id = resolveReference(run);
            if (id) runOrder.set(String(run._id), id);
        });
        (record.entries || []).forEach((entry: any) => {
            const id = runOrder.get(String(entry.runId));
            if (!id) return;
            const progress = result.get(id);
            progress.trackedQuantity += Number(entry.quantity || 0);
            progress.trackedByDate.set(
                String(record.productionDate),
                Number(progress.trackedByDate.get(String(record.productionDate)) || 0) + Number(entry.quantity || 0)
            );
            if (record.lineCode) progress.activeLineCodes.add(String(record.lineCode));
            if (!progress.lastProductionDate || record.productionDate > progress.lastProductionDate) {
                progress.lastProductionDate = String(record.productionDate);
            }
        });
    });

    const plannedByOrderDate = new Map<string, number>();
    plans.forEach((plan) => {
        (plan.allocations || []).forEach((allocation: any) => {
            const id = resolveReference(allocation);
            if (!id) return;
            const key = `${id}|${plan.productionDate}`;
            plannedByOrderDate.set(
                key,
                Number(plannedByOrderDate.get(key) || 0) + Number(allocation.plannedQuantity || 0)
            );
        });
    });

    const today = vietnamIsoDate();
    plannedByOrderDate.forEach((quantity, key) => {
        const separator = key.lastIndexOf('|');
        const id = key.slice(0, separator);
        const productionDate = key.slice(separator + 1);
        const progress = result.get(id);
        if (!progress) return;
        const alreadyProduced = productionDate === today ? Number(progress.trackedByDate.get(today) || 0) : 0;
        progress.futurePlannedQuantity += Math.max(0, quantity - alreadyProduced);
    });
    const finalized = new Map<string, OrderProgress>();
    orders.forEach((order) => {
        const id = String(order._id || order.id);
        const current = result.get(id);
        const quantities = summarizeProductionOrderProgress(current);
        const deadline = productionOrderDeadlineStatus({
            dueDate: order.dueDate,
            remainingQuantity: quantities.remainingQuantity,
            today,
        });
        finalized.set(id, {
            ...quantities,
            lastProductionDate: current.lastProductionDate,
            activeLineCodes: [...current.activeLineCodes].sort(),
            deadlineStatus: deadline.code,
            daysRemaining: deadline.daysRemaining,
        });
    });
    return finalized;
};

export const synchronizeProductionOrderLifecycle = async ({
    plantId,
    actorId,
    orderIds = [],
    orderCodes = [],
}: {
    plantId: string;
    actorId: string;
    orderIds?: string[];
    orderCodes?: string[];
}) => {
    const ids = orderIds.filter((value) => mongoose.isValidObjectId(value));
    const codes = orderCodes.map(orderKey).filter(Boolean);
    if (!ids.length && !codes.length) return [];
    const references = [
        ...(ids.length ? [{ _id: { $in: ids } }] : []),
        ...(codes.length ? [{ code: { $in: codes } }] : []),
    ];
    const orders: any[] = await ProductionOrder.find({
        plantId,
        status: { $ne: 'cancelled' },
        $or: references,
    });
    if (!orders.length) return [];
    const progressByOrder = await buildProductionOrderProgress(plantId, orders);
    const changed: any[] = [];
    for (const order of orders) {
        const progress = progressByOrder.get(String(order._id));
        if (!progress) continue;
        const nextStatus = resolveProductionOrderLifecycleStatus({
            currentStatus: order.status,
            producedQuantity: progress.producedQuantity,
            totalQuantity: Number(order.totalQuantity || 0),
            futurePlannedQuantity: progress.futurePlannedQuantity,
        });
        if (nextStatus === order.status) continue;
        const previousStatus = order.status;
        order.status = nextStatus;
        order.revision = Number(order.revision || 0) + 1;
        order.updatedBy = actorId;
        order.history.push({
            type: 'status_changed',
            fromStatus: previousStatus,
            toStatus: nextStatus,
            note: `Hệ thống đồng bộ theo sản lượng thực tế: ${progress.producedQuantity.toLocaleString('vi-VN')}/${Number(order.totalQuantity || 0).toLocaleString('vi-VN')} SP`,
            actor: actorId,
            at: new Date(),
        });
        await order.save();
        if (nextStatus === 'completed') {
            await ProductionMaterialReservation.updateMany(
                { productionOrderId: order._id, status: 'active' },
                {
                    $set: {
                        status: 'released',
                        releasedAt: new Date(),
                        releasedBy: actorId,
                        releaseReason: 'Đơn hàng đã hoàn thành theo sản lượng thực tế',
                    },
                }
            );
        }
        emitOrderUpdated(order, 'lifecycle-synced');
        changed.push({
            orderId: String(order._id),
            code: order.code,
            fromStatus: previousStatus,
            toStatus: nextStatus,
        });
    }
    return changed;
};

const serializeOrder = (input: any, progress?: OrderProgress) => {
    const order = typeof input?.toObject === 'function' ? input.toObject() : input;
    return {
        id: toId(order),
        plantId: toId(order.plantId),
        plantName: order.plantName,
        plantCode: order.plantCode,
        code: order.code,
        customerName: order.customerName,
        itemId: toId(order.itemId),
        itemCode: order.itemCode,
        itemName: order.itemName,
        unit: order.unit || 'SP',
        totalQuantity: Number(order.totalQuantity || 0),
        plannedStartDate: order.plannedStartDate,
        dueDate: order.dueDate,
        priority: order.priority || 'normal',
        status: order.status || 'draft',
        note: order.note,
        sourceType: order.sourceType || 'manual',
        sourceFileName: order.sourceFileName,
        revision: Number(order.revision || 0),
        progress,
        history: (order.history || []).map((event: any) => ({
            id: toId(event),
            type: event.type,
            fromStatus: event.fromStatus,
            toStatus: event.toStatus,
            note: event.note,
            actor: serializeActor(event.actor),
            at: toIso(event.at),
        })),
        createdBy: serializeActor(order.createdBy),
        updatedBy: serializeActor(order.updatedBy),
        createdAt: toIso(order.createdAt),
        updatedAt: toIso(order.updatedAt),
    };
};

const emitOrderUpdated = (order: any, changeType: string) => {
    emitToPlant(String(order.plantId), 'production:order-updated', {
        orderId: String(order._id),
        plantId: String(order.plantId),
        code: order.code,
        status: order.status,
        revision: Number(order.revision || 0),
        changeType,
        at: new Date().toISOString(),
    });
};

const assertDates = (plannedStartDate: string | undefined, dueDate: string) => {
    if (plannedStartDate && plannedStartDate > dueDate) {
        throw new BadRequestError('Ngày dự kiến vào chuyền phải trước hoặc bằng ngày giao hàng');
    }
};

const loadItem = async (plantId: string, itemId: string) => {
    const item: any = await ProductionItem.findOne({ _id: itemId, plantId, isActive: true }).lean();
    if (!item) throw new NotFoundError('Mã hàng không tồn tại hoặc đã ngừng sử dụng');
    return item;
};

const loadOrder = async (req: Request, id: string) => {
    const order: any = await ProductionOrder.findById(id);
    if (!order) throw new NotFoundError('Không tìm thấy đơn hàng sản xuất');
    assertPlantAccess(req, String(order.plantId));
    return order;
};

const hasLinkedData = async (order: any) =>
    Boolean(
        (await ProductionPlan.exists({
            plantId: order.plantId,
            $or: [{ 'allocations.orderId': order._id }, { 'allocations.orderCode': order.code }],
        })) ||
        (await ProductionLineRecord.exists({
            plantId: order.plantId,
            $or: [{ 'runs.orderId': order._id }, { 'runs.orderCode': order.code }],
        }))
    );

export const listProductionOrders = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const filter: any = { plantId: plant.id };
    const status = String(req.query.status || 'open');
    if (status === 'open') filter.status = { $in: OPEN_STATUSES };
    else if (status !== 'all') {
        if (!PRODUCTION_ORDER_STATUSES.includes(status as ProductionOrderStatus)) {
            throw new BadRequestError('Trạng thái đơn hàng không hợp lệ');
        }
        filter.status = status;
    }
    if (req.query.itemId) filter.itemId = String(req.query.itemId);
    const search = String(req.query.search || '').trim();
    if (search) {
        const regex = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ code: regex }, { customerName: regex }, { itemCode: regex }, { itemName: regex }];
    }
    const orders: any[] = await ProductionOrder.find(filter)
        .sort({ dueDate: 1, priority: -1, createdAt: -1 })
        .limit(500)
        .populate(ORDER_POPULATE as any);
    const progress = await buildProductionOrderProgress(plant.id, orders);
    const items = orders.map((order) => serializeOrder(order, progress.get(String(order._id))));
    const summary = {
        totalOrders: items.length,
        openOrders: items.filter((order) => OPEN_STATUSES.includes(order.status)).length,
        overdueOrders: items.filter((order) => order.progress?.deadlineStatus === 'overdue').length,
        dueSoonOrders: items.filter((order) => order.progress?.deadlineStatus === 'due_soon').length,
        totalQuantity: items.reduce((sum, order) => sum + order.totalQuantity, 0),
        producedQuantity: items.reduce((sum, order) => sum + Number(order.progress?.producedQuantity || 0), 0),
        remainingQuantity: items.reduce((sum, order) => sum + Number(order.progress?.remainingQuantity || 0), 0),
        unplannedQuantity: items.reduce((sum, order) => sum + Number(order.progress?.unplannedQuantity || 0), 0),
    };
    return sendSuccess(res, { plant, items, summary }, 'Đã tải danh sách đơn hàng sản xuất');
};

export const getProductionOrder = async (req: Request, res: Response) => {
    const order = await loadOrder(req, String(req.params.id));
    await populateOrder(order);
    const progress = await buildProductionOrderProgress(String(order.plantId), [order]);
    return sendSuccess(res, serializeOrder(order, progress.get(String(order._id))), 'Đã tải đơn hàng sản xuất');
};

export const createProductionOrder = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const code = orderKey(req.body.code);
    const item = await loadItem(plant.id, String(req.body.itemId));
    assertDates(req.body.plannedStartDate, req.body.dueDate);
    try {
        const order: any = await ProductionOrder.create({
            plantId: plant.id,
            plantName: plant.name,
            plantCode: plant.code,
            code,
            customerName: req.body.customerName || undefined,
            itemId: item._id,
            itemCode: item.code,
            itemName: item.name,
            unit: item.unit || 'SP',
            totalQuantity: req.body.totalQuantity,
            plannedStartDate: req.body.plannedStartDate || undefined,
            dueDate: req.body.dueDate,
            priority: req.body.priority || 'normal',
            status: req.body.status || 'draft',
            note: req.body.note || undefined,
            sourceType: 'manual',
            createdBy: req.userId,
            updatedBy: req.userId,
            history: [{ type: 'created', toStatus: req.body.status || 'draft', actor: req.userId, at: new Date() }],
        });
        emitOrderUpdated(order, 'created');
        return sendSuccess(
            res,
            serializeOrder(
                await populateOrder(order),
                (await buildProductionOrderProgress(plant.id, [order])).get(String(order._id))
            ),
            'Đã tạo đơn hàng sản xuất',
            StatusCodes.CREATED
        );
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError(`Mã đơn hàng ${code} đã tồn tại tại cơ sở này`);
        throw error;
    }
};

export const updateProductionOrder = async (req: Request, res: Response) => {
    const order: any = await loadOrder(req, String(req.params.id));
    if (Number(req.body.revision) !== Number(order.revision || 0)) {
        throw new DuplicateError('Đơn hàng vừa được cập nhật ở thiết bị khác, vui lòng tải lại');
    }
    const linked = await hasLinkedData(order);
    const nextCode = req.body.code === undefined ? order.code : orderKey(req.body.code);
    const nextItemId = req.body.itemId === undefined ? String(order.itemId) : String(req.body.itemId);
    if (linked && nextCode !== order.code)
        throw new BadRequestError('Không thể đổi mã đơn đã phát sinh kế hoạch hoặc sản lượng');
    if (linked && nextItemId !== String(order.itemId)) {
        throw new BadRequestError('Không thể đổi mã hàng của đơn đã phát sinh kế hoạch hoặc sản lượng');
    }
    const nextStatus = (req.body.status || order.status) as ProductionOrderStatus;
    if (
        nextStatus !== order.status &&
        !STATUS_TRANSITIONS[order.status as ProductionOrderStatus].includes(nextStatus)
    ) {
        throw new BadRequestError(`Không thể chuyển trạng thái từ ${order.status} sang ${nextStatus}`);
    }
    const nextTotal = Number(req.body.totalQuantity ?? order.totalQuantity);
    const progress = await buildProductionOrderProgress(String(order.plantId), [order]);
    const produced = Number(progress.get(String(order._id))?.producedQuantity || 0);
    if (nextTotal < produced) {
        throw new BadRequestError(`Tổng số lượng không được nhỏ hơn ${produced} SP đã sản xuất`);
    }
    const nextStart =
        req.body.plannedStartDate === undefined ? order.plannedStartDate : req.body.plannedStartDate || undefined;
    const nextDue = req.body.dueDate || order.dueDate;
    assertDates(nextStart, nextDue);
    const item = nextItemId === String(order.itemId) ? null : await loadItem(String(order.plantId), nextItemId);
    const previousStatus = order.status;
    const previousTotalQuantity = Number(order.totalQuantity || 0);
    const previousItemId = String(order.itemId);
    order.code = nextCode;
    if (item) {
        order.itemId = item._id;
        order.itemCode = item.code;
        order.itemName = item.name;
        order.unit = item.unit || 'SP';
    }
    ['customerName', 'note'].forEach((field) => {
        if (req.body[field] !== undefined) order[field] = req.body[field] || undefined;
    });
    order.totalQuantity = nextTotal;
    order.plannedStartDate = nextStart;
    order.dueDate = nextDue;
    order.priority = req.body.priority || order.priority;
    order.status = nextStatus;
    order.revision += 1;
    order.updatedBy = req.userId;
    order.history.push({
        type: previousStatus === nextStatus ? 'updated' : 'status_changed',
        fromStatus: previousStatus === nextStatus ? undefined : previousStatus,
        toStatus: previousStatus === nextStatus ? undefined : nextStatus,
        note: req.body.changeReason,
        actor: req.userId,
        at: new Date(),
    });
    try {
        await order.save();
    } catch (error: any) {
        if (error?.name === 'VersionError') {
            throw new DuplicateError('Đơn hàng vừa được cập nhật ở thiết bị khác, vui lòng tải lại');
        }
        if (error?.code === 11000) throw new DuplicateError(`Mã đơn hàng ${nextCode} đã tồn tại tại cơ sở này`);
        throw error;
    }
    const reservationInvalidated =
        ['completed', 'cancelled'].includes(nextStatus) ||
        nextTotal !== previousTotalQuantity ||
        nextItemId !== previousItemId;
    if (reservationInvalidated) {
        await ProductionMaterialReservation.updateMany(
            { productionOrderId: order._id, status: 'active' },
            {
                $set: {
                    status: 'released',
                    releasedAt: new Date(),
                    releasedBy: req.userId,
                    releaseReason: `Đơn hàng thay đổi trạng thái hoặc số lượng: ${req.body.changeReason}`,
                    updatedBy: req.userId,
                },
            }
        );
        emitToPlant(String(order.plantId), 'production:material-updated', {
            plantId: String(order.plantId),
            orderId: String(order._id),
        });
    }
    emitOrderUpdated(order, previousStatus === nextStatus ? 'updated' : 'status-changed');
    const updatedProgress = await buildProductionOrderProgress(String(order.plantId), [order]);
    return sendSuccess(
        res,
        serializeOrder(await populateOrder(order), updatedProgress.get(String(order._id))),
        'Đã cập nhật đơn hàng sản xuất'
    );
};

const cellValue = (cell: ExcelJS.Cell): unknown => {
    const value: any = cell.value;
    if (value && typeof value === 'object') {
        if ('result' in value) return value.result;
        if (Array.isArray(value.richText)) return value.richText.map((part: any) => part.text).join('');
        if ('text' in value) return value.text;
    }
    return value;
};

const numericValue = (value: unknown) => {
    if (typeof value === 'number') return value;
    let text = String(value || '')
        .trim()
        .replace(/\s/g, '');
    if (/^\d{1,3}([.,]\d{3})+$/.test(text)) text = text.replace(/[.,]/g, '');
    else text = text.replace(',', '.');
    return Number(text.replace(/[^0-9.-]/g, ''));
};

const HEADER_ALIASES: Record<string, keyof Omit<ImportRow, 'rowNumber' | 'action' | 'errors'>> = {
    'ma don hang': 'code',
    'ma don': 'code',
    'order code': 'code',
    'khach hang': 'customerName',
    customer: 'customerName',
    'ma hang': 'itemCode',
    'item code': 'itemCode',
    'tong so luong': 'totalQuantity',
    'so luong': 'totalQuantity',
    quantity: 'totalQuantity',
    'ngay vao chuyen': 'plannedStartDate',
    'ngay du kien vao chuyen': 'plannedStartDate',
    'planned start': 'plannedStartDate',
    'ngay giao': 'dueDate',
    'han giao': 'dueDate',
    'due date': 'dueDate',
    'uu tien': 'priority',
    priority: 'priority',
    'trang thai': 'status',
    status: 'status',
    'ghi chu': 'note',
    note: 'note',
};

const parseImportWorkbook = async (
    buffer: Buffer,
    plantId: string
): Promise<{ sheetName: string; rows: ImportRow[] }> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    let selected: { sheet: ExcelJS.Worksheet; headerRow: number; columns: Map<number, string> } | undefined;
    for (const sheet of workbook.worksheets) {
        for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 15); rowNumber += 1) {
            const columns = new Map<number, string>();
            sheet.getRow(rowNumber).eachCell((cell, column) => {
                const key = HEADER_ALIASES[normalizeProductionOrderHeader(cellValue(cell))];
                if (key) columns.set(column, key);
            });
            const keys = new Set(columns.values());
            if (keys.has('code') && keys.has('itemCode') && keys.has('totalQuantity') && keys.has('dueDate')) {
                selected = { sheet, headerRow: rowNumber, columns };
                break;
            }
        }
        if (selected) break;
    }
    if (!selected) {
        throw new BadRequestError('Không tìm thấy bảng có các cột Mã đơn hàng, Mã hàng, Tổng số lượng và Ngày giao');
    }
    const rawRows: Array<Record<string, unknown> & { rowNumber: number }> = [];
    for (let rowNumber = selected.headerRow + 1; rowNumber <= selected.sheet.rowCount; rowNumber += 1) {
        const row = selected.sheet.getRow(rowNumber);
        const raw: Record<string, unknown> & { rowNumber: number } = { rowNumber };
        selected.columns.forEach((key, column) => {
            raw[key] = cellValue(row.getCell(column));
        });
        if (!Object.values(raw).some((value, index) => index > 0 && String(value || '').trim())) continue;
        rawRows.push(raw);
    }
    if (!rawRows.length) throw new BadRequestError('File Excel không có dòng đơn hàng nào');
    if (rawRows.length > 500) throw new BadRequestError('Mỗi lần chỉ được nhập tối đa 500 đơn hàng');

    const itemCodes = [...new Set(rawRows.map((row) => orderKey(row.itemCode)).filter(Boolean))];
    const orderCodes = [...new Set(rawRows.map((row) => orderKey(row.code)).filter(Boolean))];
    const [items, existingOrders]: [any[], any[]] = await Promise.all([
        ProductionItem.find({ plantId, code: { $in: itemCodes }, isActive: true }).lean(),
        ProductionOrder.find({ plantId, code: { $in: orderCodes } }).lean(),
    ]);
    const itemByCode = new Map(items.map((item) => [orderKey(item.code), item]));
    const existingByCode = new Map(existingOrders.map((order) => [orderKey(order.code), order]));
    const seen = new Set<string>();
    const rows = rawRows.map((raw): ImportRow => {
        const errors: string[] = [];
        const code = orderKey(raw.code);
        const itemCode = orderKey(raw.itemCode);
        const item = itemByCode.get(itemCode);
        const existing = existingByCode.get(code);
        const totalQuantity = numericValue(raw.totalQuantity);
        const plannedStartDate = parseProductionOrderDate(raw.plannedStartDate);
        const dueDate = parseProductionOrderDate(raw.dueDate);
        if (!code) errors.push('Thiếu mã đơn hàng');
        else if (seen.has(code)) errors.push('Mã đơn hàng bị lặp trong file');
        seen.add(code);
        if (!itemCode) errors.push('Thiếu mã hàng');
        else if (!item) errors.push(`Mã hàng ${itemCode} không tồn tại hoặc đã ngừng sử dụng`);
        if (!Number.isInteger(totalQuantity) || totalQuantity <= 0)
            errors.push('Tổng số lượng phải là số nguyên dương');
        if (!dueDate) errors.push('Ngày giao không hợp lệ');
        if (raw.plannedStartDate && !plannedStartDate) errors.push('Ngày vào chuyền không hợp lệ');
        if (plannedStartDate && dueDate && plannedStartDate > dueDate) {
            errors.push('Ngày vào chuyền phải trước hoặc bằng ngày giao');
        }
        if (raw.priority && !isRecognizedProductionOrderPriority(raw.priority)) {
            errors.push(`Mức ưu tiên "${String(raw.priority).trim()}" không hợp lệ`);
        }
        if (raw.status && !isRecognizedProductionOrderStatus(raw.status)) {
            errors.push(`Trạng thái "${String(raw.status).trim()}" không hợp lệ`);
        }
        return {
            rowNumber: raw.rowNumber,
            code,
            customerName: String(raw.customerName || '').trim() || undefined,
            itemId: item ? String(item._id) : undefined,
            itemCode,
            itemName: item?.name,
            totalQuantity: Number.isFinite(totalQuantity) ? totalQuantity : 0,
            plannedStartDate,
            dueDate,
            priority: raw.priority ? parseProductionOrderPriority(raw.priority) : existing?.priority || 'normal',
            status: raw.status ? parseProductionOrderStatus(raw.status) : existing?.status || 'draft',
            note: String(raw.note || '').trim() || undefined,
            action: errors.length ? 'error' : existing ? 'update' : 'create',
            existingId: existing ? String(existing._id) : undefined,
            errors,
        };
    });
    return { sheetName: selected.sheet.name, rows };
};

const importSummary = (rows: ImportRow[]) => ({
    totalRows: rows.length,
    validRows: rows.filter((row) => !row.errors.length).length,
    errorRows: rows.filter((row) => row.errors.length).length,
    createRows: rows.filter((row) => row.action === 'create').length,
    updateRows: rows.filter((row) => row.action === 'update').length,
    totalQuantity: rows.filter((row) => !row.errors.length).reduce((sum, row) => sum + row.totalQuantity, 0),
});

const assertExcelFile = (req: Request) => {
    if (!req.file) throw new BadRequestError('Cần chọn file Excel');
    if (!/\.xlsx$/i.test(req.file.originalname)) throw new BadRequestError('Chỉ hỗ trợ file Excel .xlsx');
};

export const previewProductionOrderImport = async (req: Request, res: Response) => {
    assertExcelFile(req);
    const plant = await resolvePlant(req, req.body.plantId);
    const parsed = await parseImportWorkbook(req.file!.buffer, plant.id);
    return sendSuccess(
        res,
        {
            plant,
            sourceFileName: req.file!.originalname,
            sourceSheet: parsed.sheetName,
            rows: parsed.rows,
            summary: importSummary(parsed.rows),
        },
        'Đã đọc trước file đơn hàng sản xuất'
    );
};

export const confirmProductionOrderImport = async (req: Request, res: Response) => {
    assertExcelFile(req);
    const plant = await resolvePlant(req, req.body.plantId);
    const parsed = await parseImportWorkbook(req.file!.buffer, plant.id);
    const summary = importSummary(parsed.rows);
    if (summary.errorRows) throw new BadRequestError(`File còn ${summary.errorRows} dòng lỗi, chưa thể xác nhận`);
    const existingIds = parsed.rows.map((row) => row.existingId).filter(Boolean) as string[];
    const existingOrders: any[] = existingIds.length ? await ProductionOrder.find({ _id: { $in: existingIds } }) : [];
    const existingById = new Map(existingOrders.map((order) => [String(order._id), order]));
    const existingProgress = await buildProductionOrderProgress(plant.id, existingOrders);
    const itemIds = [...new Set(parsed.rows.map((row) => row.itemId).filter(Boolean))] as string[];
    const items: any[] = await ProductionItem.find({ _id: { $in: itemIds }, plantId: plant.id, isActive: true }).lean();
    const itemById = new Map(items.map((item) => [String(item._id), item]));

    // Validate the complete file before opening the transaction so users get a row-specific error
    // and no earlier row can be persisted when a later row is invalid.
    for (const row of parsed.rows) {
        if (!row.itemId || !row.dueDate) throw new BadRequestError(`Dòng ${row.rowNumber}: dữ liệu chưa đầy đủ`);
        if (!itemById.has(row.itemId)) {
            throw new BadRequestError(`Dòng ${row.rowNumber}: mã hàng không tồn tại hoặc đã ngừng sử dụng`);
        }
        const existing = row.existingId ? existingById.get(row.existingId) : undefined;
        if (!existing) continue;
        const produced = Number(existingProgress.get(String(existing._id))?.producedQuantity || 0);
        if (row.totalQuantity < produced) {
            throw new BadRequestError(`Dòng ${row.rowNumber}: số lượng nhỏ hơn ${produced} SP đã sản xuất`);
        }
        if (String(existing.itemId) !== row.itemId && (await hasLinkedData(existing))) {
            throw new BadRequestError(`Dòng ${row.rowNumber}: không thể đổi mã hàng của đơn đã phát sinh dữ liệu`);
        }
        if (
            row.status !== existing.status &&
            !STATUS_TRANSITIONS[existing.status as ProductionOrderStatus].includes(row.status)
        ) {
            throw new BadRequestError(
                `Dòng ${row.rowNumber}: không thể chuyển trạng thái từ ${existing.status} sang ${row.status}`
            );
        }
    }

    const changed: any[] = [];
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            for (const row of parsed.rows) {
                const item = itemById.get(row.itemId!);
                const existing = row.existingId ? existingById.get(row.existingId) : undefined;
                if (existing) {
                    const previousStatus = existing.status;
                    const previousTotalQuantity = Number(existing.totalQuantity || 0);
                    const previousItemId = String(existing.itemId);
                    existing.customerName = row.customerName;
                    existing.itemId = item._id;
                    existing.itemCode = item.code;
                    existing.itemName = item.name;
                    existing.unit = item.unit || 'SP';
                    existing.totalQuantity = row.totalQuantity;
                    existing.plannedStartDate = row.plannedStartDate;
                    existing.dueDate = row.dueDate;
                    existing.priority = row.priority;
                    existing.status = row.status;
                    existing.note = row.note;
                    existing.sourceType = 'excel';
                    existing.sourceFileName = req.file!.originalname;
                    existing.revision += 1;
                    existing.updatedBy = req.userId;
                    existing.history.push({
                        type: 'imported',
                        fromStatus: previousStatus === row.status ? undefined : previousStatus,
                        toStatus: previousStatus === row.status ? undefined : row.status,
                        note: `Cập nhật từ ${req.file!.originalname}`,
                        actor: req.userId,
                        at: new Date(),
                    });
                    await existing.save({ session });
                    if (
                        ['completed', 'cancelled'].includes(row.status) ||
                        row.totalQuantity !== previousTotalQuantity ||
                        String(item._id) !== previousItemId
                    ) {
                        await ProductionMaterialReservation.updateMany(
                            { productionOrderId: existing._id, status: 'active' },
                            {
                                $set: {
                                    status: 'released',
                                    releasedAt: new Date(),
                                    releasedBy: req.userId,
                                    releaseReason: `Đơn hàng cập nhật từ ${req.file!.originalname}`,
                                    updatedBy: req.userId,
                                },
                            },
                            { session }
                        );
                    }
                    changed.push(existing);
                    continue;
                }
                const [created] = await ProductionOrder.create(
                    [
                        {
                            plantId: plant.id,
                            plantName: plant.name,
                            plantCode: plant.code,
                            code: row.code,
                            customerName: row.customerName,
                            itemId: item._id,
                            itemCode: item.code,
                            itemName: item.name,
                            unit: item.unit || 'SP',
                            totalQuantity: row.totalQuantity,
                            plannedStartDate: row.plannedStartDate,
                            dueDate: row.dueDate,
                            priority: row.priority,
                            status: row.status,
                            note: row.note,
                            sourceType: 'excel',
                            sourceFileName: req.file!.originalname,
                            createdBy: req.userId,
                            updatedBy: req.userId,
                            history: [
                                {
                                    type: 'imported',
                                    toStatus: row.status,
                                    note: `Tạo từ ${req.file!.originalname}`,
                                    actor: req.userId,
                                    at: new Date(),
                                },
                            ],
                        },
                    ],
                    { session }
                );
                changed.push(created);
            }
        });
    } catch (error: any) {
        if (error?.code === 11000) {
            throw new DuplicateError('Có mã đơn hàng vừa được tạo bởi người khác, vui lòng xem trước lại file');
        }
        throw error;
    } finally {
        await session.endSession();
    }
    changed.forEach((order) => {
        emitOrderUpdated(order, 'imported');
        emitToPlant(String(order.plantId), 'production:material-updated', {
            plantId: String(order.plantId),
            orderId: String(order._id),
        });
    });
    return sendSuccess(
        res,
        { createdCount: summary.createRows, updatedCount: summary.updateRows, totalQuantity: summary.totalQuantity },
        'Đã nhập danh sách đơn hàng sản xuất'
    );
};

export const downloadProductionOrderTemplate = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    const sheet = workbook.addWorksheet('DON_HANG', {
        views: [{ state: 'frozen', ySplit: 2 }],
        pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    sheet.mergeCells('A1:J1');
    sheet.getCell('A1').value = `DANH SÁCH ĐƠN HÀNG SẢN XUẤT - ${plant.name}`;
    sheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17324D' } };
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 28;
    const headers = [
        'Mã đơn hàng',
        'Khách hàng',
        'Mã hàng',
        'Tổng số lượng',
        'Ngày dự kiến vào chuyền',
        'Ngày giao',
        'Ưu tiên',
        'Trạng thái',
        'Ghi chú',
        'Hướng dẫn',
    ];
    sheet.addRow(headers);
    sheet.getRow(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.getRow(2).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet.addRow([
        'PO-2026-001',
        'Khách hàng A',
        '416',
        5000,
        '15/09/2026',
        '30/09/2026',
        'Cao',
        'Nháp',
        '',
        'Xóa dòng mẫu trước khi nhập',
    ]);
    sheet.columns = [
        { width: 20 },
        { width: 24 },
        { width: 15 },
        { width: 16 },
        { width: 24 },
        { width: 16 },
        { width: 13 },
        { width: 18 },
        { width: 30 },
        { width: 30 },
    ];
    sheet.autoFilter = { from: 'A2', to: 'J2' };
    sheet.getColumn(4).numFmt = '#,##0';
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="production-orders-${plant.code || plant.id}.xlsx"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};
