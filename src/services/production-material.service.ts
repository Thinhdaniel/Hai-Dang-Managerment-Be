import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
import ProductionBom from '@/models/ProductionBom';
import ProductionItem from '@/models/ProductionItem';
import ProductionMaterialReservation from '@/models/ProductionMaterialReservation';
import ProductionMaterialReservationLock from '@/models/ProductionMaterialReservationLock';
import ProductionMaterialSnapshot from '@/models/ProductionMaterialSnapshot';
import ProductionOrder from '@/models/ProductionOrder';
import PurchaseOrder from '@/models/PurchaseOrder';
import { vietnamIsoDate } from '@/utils/vietnamDate';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
    calculateBomRequirement,
    calculateMaterialLineReadiness,
    calculateReservableQuantity,
    roundMaterialQuantity,
    summarizeMaterialReadiness,
} from './production-material.helpers';
import { sendSuccess } from './service.helpers';

const OPEN_ORDER_STATUSES = ['draft', 'ready', 'in_production', 'paused'];
const ACTOR_SELECT = 'fullname username email';
const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');
const actorId = (req: Request) => {
    if (!req.userId || !mongoose.isValidObjectId(req.userId))
        throw new UnAuthorizedError('Phiên đăng nhập không hợp lệ');
    return new mongoose.Types.ObjectId(req.userId);
};
const toId = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    return String(value._id || value);
};
const toIso = (value: any) => (value ? new Date(value).toISOString() : undefined);

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền quản lý readiness vật tư của cơ sở này');
    }
};

const resolvePlant = async (req: Request, input: unknown) => {
    const id = String(input || userPlantId(req) || '');
    if (!id || !mongoose.isValidObjectId(id)) throw new BadRequestError('Cần chọn cơ sở hợp lệ');
    assertPlantAccess(req, id);
    const plant: any = await Plant.findOne({ _id: id, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: String(plant._id), name: plant.name, code: plant.code || '' };
};

const serializeActor = (value: any) => {
    const id = toId(value);
    if (!id) return undefined;
    return {
        id,
        name: value?.fullname || value?.username || value?.email,
    };
};

const serializeBom = (input: any) => {
    const bom = typeof input?.toObject === 'function' ? input.toObject() : input;
    return {
        id: toId(bom),
        plantId: toId(bom.plantId),
        itemId: toId(bom.itemId),
        itemCode: bom.itemCode,
        itemName: bom.itemName,
        version: Number(bom.version || 0),
        status: bom.status,
        effectiveFrom: bom.effectiveFrom,
        note: bom.note,
        revision: Number(bom.revision || 0),
        lines: (bom.lines || []).map((line: any) => ({
            id: toId(line),
            materialId: toId(line.materialId),
            materialCode: line.materialCode,
            materialName: line.materialName,
            unit: line.unit,
            quantityPerUnit: Number(line.quantityPerUnit || 0),
            wastagePercent: Number(line.wastagePercent || 0),
            isRequired: line.isRequired !== false,
            operationName: line.operationName,
            note: line.note,
        })),
        approvedAt: toIso(bom.approvedAt),
        approvedBy: serializeActor(bom.approvedBy),
        createdBy: serializeActor(bom.createdBy),
        updatedBy: serializeActor(bom.updatedBy),
        createdAt: toIso(bom.createdAt),
        updatedAt: toIso(bom.updatedAt),
    };
};

type QueryOptions = { session?: mongoose.ClientSession };

const loadReadinessRows = async (plantId: string, orderIds?: string[], options: QueryOptions = {}) => {
    const orderFilter: any = { plantId, status: { $in: OPEN_ORDER_STATUSES } };
    if (orderIds?.length) orderFilter._id = { $in: orderIds };
    const orders: any[] = await ProductionOrder.find(orderFilter)
        .sort({ dueDate: 1, priority: -1, code: 1 })
        .session(options.session || null)
        .lean();
    if (!orders.length) return [];

    const itemIds = [...new Set(orders.map((order) => String(order.itemId)))];
    const boms: any[] = await ProductionBom.find({ plantId, itemId: { $in: itemIds }, status: 'approved' })
        .session(options.session || null)
        .lean();
    const bomByItem = new Map(boms.map((bom) => [String(bom.itemId), bom]));
    const materialIds = [
        ...new Set(boms.flatMap((bom) => (bom.lines || []).map((line: any) => String(line.materialId)))),
    ];

    const [stocks, reservations, purchaseOrders, snapshots]: [any[], any[], any[], any[]] = await Promise.all([
        materialIds.length
            ? (InventoryStock as any)
                  .find({ plantId, materialId: { $in: materialIds }, isDeleted: { $ne: true } })
                  .session(options.session || null)
                  .lean()
            : [],
        materialIds.length
            ? ProductionMaterialReservation.find({
                  plantId,
                  materialId: { $in: materialIds },
                  status: 'active',
              })
                  .session(options.session || null)
                  .lean()
            : [],
        materialIds.length
            ? PurchaseOrder.find({
                  isDeleted: { $ne: true },
                  status: { $in: ['ordered', 'partially_received'] },
                  'items.materialId': { $in: materialIds },
              })
                  .select('orderCode plantId status items')
                  .session(options.session || null)
                  .lean()
            : [],
        ProductionMaterialSnapshot.aggregate([
            {
                $match: {
                    plantId: new mongoose.Types.ObjectId(plantId),
                    productionOrderId: { $in: orders.map((o) => o._id) },
                },
            },
            { $sort: { asOf: -1 } },
            { $group: { _id: '$productionOrderId', snapshot: { $first: '$$ROOT' } } },
        ]).session(options.session || null),
    ]);

    const stockByMaterial = new Map(stocks.map((stock) => [String(stock.materialId), Number(stock.currentStock || 0)]));
    const reservationsByMaterial = new Map<string, any[]>();
    reservations.forEach((reservation) => {
        const key = String(reservation.materialId);
        const list = reservationsByMaterial.get(key) || [];
        list.push(reservation);
        reservationsByMaterial.set(key, list);
    });
    const inboundByMaterial = new Map<string, any[]>();
    purchaseOrders.forEach((purchaseOrder) => {
        (purchaseOrder.items || []).forEach((item: any) => {
            const materialId = String(item.materialId || '');
            const targetPlantId = String(item.plantId || purchaseOrder.plantId || '');
            if (!materialIds.includes(materialId) || targetPlantId !== plantId || item.lineStatus === 'cancelled')
                return;
            const quantity = roundMaterialQuantity(
                Math.max(0, Number(item.quantityOrdered || 0) - Number(item.quantityReceived || 0))
            );
            if (!quantity) return;
            const rows = inboundByMaterial.get(materialId) || [];
            rows.push({
                purchaseOrderId: String(purchaseOrder._id),
                purchaseOrderCode: purchaseOrder.orderCode,
                quantity,
                // PurchaseOrder hiện chưa quản lý ETA. Không tự suy đoán ngày về.
                expectedDate: undefined,
            });
            inboundByMaterial.set(materialId, rows);
        });
    });
    const latestSnapshotByOrder = new Map(snapshots.map((row) => [String(row._id), row.snapshot]));
    const today = vietnamIsoDate();

    return orders.map((order) => {
        const bom = bomByItem.get(String(order.itemId));
        const latestSnapshot = latestSnapshotByOrder.get(String(order._id));
        if (!bom) {
            return {
                order: {
                    id: String(order._id),
                    code: order.code,
                    itemId: String(order.itemId),
                    itemCode: order.itemCode,
                    itemName: order.itemName,
                    customerName: order.customerName,
                    totalQuantity: Number(order.totalQuantity || 0),
                    plannedStartDate: order.plannedStartDate,
                    dueDate: order.dueDate,
                    priority: order.priority,
                    status: order.status,
                },
                bom: undefined,
                status: 'unknown' as const,
                reservationStatus: 'not_configured' as const,
                materialReadyDate: undefined,
                lines: [],
                summary: {
                    requiredLineCount: 0,
                    readyLineCount: 0,
                    shortageLineCount: 0,
                    unknownInboundLineCount: 0,
                },
                latestSnapshot: latestSnapshot
                    ? {
                          id: String(latestSnapshot._id),
                          status: latestSnapshot.status,
                          asOf: toIso(latestSnapshot.asOf),
                      }
                    : undefined,
            };
        }

        const lines = (bom.lines || []).map((line: any) => {
            const materialId = String(line.materialId);
            const materialReservations = reservationsByMaterial.get(materialId) || [];
            const ownReservation = materialReservations.find(
                (reservation) => String(reservation.productionOrderId) === String(order._id)
            );
            const totalReservedQuantity = materialReservations.reduce(
                (sum, reservation) => sum + Number(reservation.quantity || 0),
                0
            );
            const inboundSources = inboundByMaterial.get(materialId) || [];
            const inboundQuantity = roundMaterialQuantity(
                inboundSources.reduce((sum, source) => sum + Number(source.quantity || 0), 0)
            );
            const confirmedInboundQuantity = roundMaterialQuantity(
                inboundSources
                    .filter((source) => source.expectedDate && source.expectedDate <= order.plannedStartDate)
                    .reduce((sum, source) => sum + Number(source.quantity || 0), 0)
            );
            const readiness = calculateMaterialLineReadiness({
                requiredQuantity: calculateBomRequirement({
                    orderQuantity: Number(order.totalQuantity || 0),
                    quantityPerUnit: Number(line.quantityPerUnit || 0),
                    wastagePercent: Number(line.wastagePercent || 0),
                }),
                onHandQuantity: stockByMaterial.get(materialId) || 0,
                reservedForOrderQuantity: Number(ownReservation?.quantity || 0),
                totalReservedQuantity,
                confirmedInboundQuantity,
            });
            return {
                id: String(line._id),
                materialId,
                materialCode: line.materialCode,
                materialName: line.materialName,
                unit: line.unit,
                quantityPerUnit: Number(line.quantityPerUnit || 0),
                wastagePercent: Number(line.wastagePercent || 0),
                isRequired: line.isRequired !== false,
                operationName: line.operationName,
                ...readiness,
                inboundQuantity,
                readyDate: readiness.status === 'ready' ? today : undefined,
                inboundSources,
            };
        });
        const summary = summarizeMaterialReadiness(lines);
        const requiredLines = lines.filter((line: any) => line.isRequired);
        const fullyReservedCount = requiredLines.filter(
            (line: any) => line.reservedForOrderQuantity >= line.requiredQuantity
        ).length;
        const reservationStatus =
            fullyReservedCount === requiredLines.length
                ? 'reserved'
                : lines.some((line: any) => line.reservedForOrderQuantity > 0)
                  ? 'partial'
                  : 'unreserved';
        return {
            order: {
                id: String(order._id),
                code: order.code,
                itemId: String(order.itemId),
                itemCode: order.itemCode,
                itemName: order.itemName,
                customerName: order.customerName,
                totalQuantity: Number(order.totalQuantity || 0),
                plannedStartDate: order.plannedStartDate,
                dueDate: order.dueDate,
                priority: order.priority,
                status: order.status,
            },
            bom: { id: String(bom._id), version: Number(bom.version), revision: Number(bom.revision || 0) },
            status: summary.status,
            reservationStatus,
            materialReadyDate: summary.materialReadyDate,
            lines,
            summary: {
                requiredLineCount: summary.requiredLineCount,
                readyLineCount: summary.readyLineCount,
                shortageLineCount: summary.shortageLineCount,
                unknownInboundLineCount: summary.unknownInboundLineCount,
            },
            latestSnapshot: latestSnapshot
                ? { id: String(latestSnapshot._id), status: latestSnapshot.status, asOf: toIso(latestSnapshot.asOf) }
                : undefined,
        };
    });
};

const snapshotPayload = (plantId: string, row: any, createdBy: mongoose.Types.ObjectId) => ({
    plantId,
    productionOrderId: row.order.id,
    productionOrderCode: row.order.code,
    bomId: row.bom?.id,
    bomVersion: row.bom?.version,
    asOf: new Date(),
    status: row.status,
    materialReadyDate: row.materialReadyDate,
    lines: row.lines.map((line: any) => ({
        materialId: line.materialId,
        materialCode: line.materialCode,
        materialName: line.materialName,
        unit: line.unit,
        isRequired: line.isRequired,
        requiredQuantity: line.requiredQuantity,
        onHandQuantity: line.onHandQuantity,
        reservedForOrderQuantity: line.reservedForOrderQuantity,
        reservedForOtherOrdersQuantity: line.reservedForOtherOrdersQuantity,
        freeQuantity: line.freeQuantity,
        availableForOrderQuantity: line.availableForOrderQuantity,
        inboundQuantity: line.inboundQuantity,
        confirmedInboundQuantity: line.confirmedInboundQuantity,
        shortageQuantity: line.shortageQuantity,
        status: line.status,
        readyDate: line.readyDate,
        inboundSources: line.inboundSources,
    })),
    summary: row.summary,
    createdBy,
});

export const listProductionBoms = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const filter: any = { plantId: plant.id };
    if (req.query.itemId) filter.itemId = String(req.query.itemId);
    const boms = await ProductionBom.find(filter)
        .populate('createdBy updatedBy approvedBy', ACTOR_SELECT)
        .sort({ itemCode: 1, version: -1 });
    return sendSuccess(res, { plant, items: boms.map(serializeBom) }, 'Đã tải danh sách BOM');
};

export const saveProductionBomDraft = async (req: Request, res: Response) => {
    const item: any = await ProductionItem.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!item) throw new NotFoundError('Không tìm thấy mã hàng');
    const plant = await resolvePlant(req, req.body.plantId || item.plantId);
    if (String(item.plantId) !== plant.id) throw new BadRequestError('Mã hàng không thuộc cơ sở đã chọn');
    const materialIds = req.body.lines.map((line: any) => String(line.materialId));
    const materials: any[] = await Material.find({
        _id: { $in: materialIds },
        isDeleted: { $ne: true },
        isActive: true,
    }).lean();
    if (materials.length !== materialIds.length)
        throw new BadRequestError('Có vật tư không tồn tại hoặc đã ngừng dùng');
    const materialById = new Map(materials.map((material) => [String(material._id), material]));
    const lines = req.body.lines.map((line: any) => {
        const material = materialById.get(String(line.materialId));
        return {
            materialId: material._id,
            materialCode: material.code,
            materialName: material.name,
            unit: material.unit,
            quantityPerUnit: Number(line.quantityPerUnit),
            wastagePercent: Number(line.wastagePercent || 0),
            isRequired: line.isRequired !== false,
            operationName: line.operationName,
            note: line.note,
        };
    });
    const actor = actorId(req);
    let draft: any = await ProductionBom.findOne({ plantId: plant.id, itemId: item._id, status: 'draft' });
    if (draft) {
        if (Number(req.body.revision) !== Number(draft.revision || 0)) {
            throw new BadRequestError('BOM vừa được người khác cập nhật. Hãy tải lại trước khi lưu');
        }
        draft.lines = lines;
        draft.effectiveFrom = req.body.effectiveFrom;
        draft.note = req.body.note;
        draft.updatedBy = actor;
        draft.revision = Number(draft.revision || 0) + 1;
        draft.history.push({ type: 'updated', note: req.body.changeReason, actor, at: new Date() });
    } else {
        const latest: any = await ProductionBom.findOne({ plantId: plant.id, itemId: item._id })
            .sort({ version: -1 })
            .select('version')
            .lean();
        draft = new ProductionBom({
            plantId: plant.id,
            itemId: item._id,
            itemCode: item.code,
            itemName: item.name,
            version: Number(latest?.version || 0) + 1,
            status: 'draft',
            effectiveFrom: req.body.effectiveFrom,
            note: req.body.note,
            lines,
            revision: 0,
            createdBy: actor,
            updatedBy: actor,
            history: [{ type: 'created', note: req.body.changeReason, actor, at: new Date() }],
        });
    }
    await draft.save();
    await draft.populate('createdBy updatedBy approvedBy', ACTOR_SELECT);
    emitToPlant(plant.id, 'production:material-updated', { plantId: plant.id, itemId: String(item._id) });
    return sendSuccess(res, serializeBom(draft), 'Đã lưu BOM nháp');
};

export const approveProductionBom = async (req: Request, res: Response) => {
    const draft: any = await ProductionBom.findById(req.params.id);
    if (!draft) throw new NotFoundError('Không tìm thấy BOM');
    assertPlantAccess(req, String(draft.plantId));
    if (draft.status !== 'draft') throw new BadRequestError('Chỉ BOM nháp mới được duyệt');
    if (Number(req.body.revision) !== Number(draft.revision || 0)) {
        throw new BadRequestError('BOM vừa được cập nhật. Hãy tải lại trước khi duyệt');
    }
    if (!draft.lines.length) throw new BadRequestError('BOM chưa có vật tư');
    if (draft.effectiveFrom && draft.effectiveFrom > vietnamIsoDate()) {
        throw new BadRequestError('BOM tương lai chưa thể duyệt trong phiên bản hiện tại');
    }
    const actor = actorId(req);
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await ProductionBom.updateMany(
                { plantId: draft.plantId, itemId: draft.itemId, status: 'approved', _id: { $ne: draft._id } },
                {
                    $set: { status: 'archived', updatedBy: actor },
                    $push: {
                        history: { type: 'archived', note: `Thay bởi BOM v${draft.version}`, actor, at: new Date() },
                    },
                },
                { session }
            );
            const openOrders = await ProductionOrder.find({
                plantId: draft.plantId,
                itemId: draft.itemId,
                status: { $in: OPEN_ORDER_STATUSES },
            })
                .select('_id')
                .session(session)
                .lean();
            await ProductionMaterialReservation.updateMany(
                { productionOrderId: { $in: openOrders.map((order) => order._id) }, status: 'active' },
                {
                    $set: {
                        status: 'released',
                        releasedAt: new Date(),
                        releasedBy: actor,
                        releaseReason: `BOM v${draft.version} được duyệt, cần giữ tồn lại`,
                        updatedBy: actor,
                    },
                },
                { session }
            );
            draft.status = 'approved';
            draft.approvedAt = new Date();
            draft.approvedBy = actor;
            draft.updatedBy = actor;
            draft.revision = Number(draft.revision || 0) + 1;
            draft.history.push({ type: 'approved', note: req.body.note, actor, at: new Date() });
            await draft.save({ session });
        });
    } finally {
        await session.endSession();
    }
    await draft.populate('createdBy updatedBy approvedBy', ACTOR_SELECT);
    emitToPlant(String(draft.plantId), 'production:material-updated', {
        plantId: String(draft.plantId),
        itemId: String(draft.itemId),
    });
    return sendSuccess(res, serializeBom(draft), 'Đã duyệt và ban hành BOM');
};

export const getProductionMaterialReadiness = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const rows = await loadReadinessRows(plant.id);
    const filtered = req.query.status ? rows.filter((row) => row.status === req.query.status) : rows;
    return sendSuccess(
        res,
        {
            plant,
            asOf: new Date().toISOString(),
            summary: {
                orderCount: rows.length,
                readyCount: rows.filter((row) => row.status === 'ready').length,
                partialCount: rows.filter((row) => row.status === 'partial').length,
                shortageCount: rows.filter((row) => row.status === 'shortage').length,
                unknownCount: rows.filter((row) => row.status === 'unknown').length,
                shortageLineCount: rows.reduce((sum, row) => sum + row.summary.shortageLineCount, 0),
                unconfirmedInboundLineCount: rows.reduce((sum, row) => sum + row.summary.unknownInboundLineCount, 0),
            },
            items: filtered,
        },
        'Đã đối chiếu readiness nguyên phụ liệu'
    );
};

export const reserveProductionOrderMaterials = async (req: Request, res: Response) => {
    const order: any = await ProductionOrder.findById(req.params.id).lean();
    if (!order) throw new NotFoundError('Không tìm thấy đơn hàng sản xuất');
    assertPlantAccess(req, String(order.plantId));
    if (!OPEN_ORDER_STATUSES.includes(order.status)) throw new BadRequestError('Đơn hàng đã đóng, không thể giữ tồn');
    const actor = actorId(req);
    const session = await mongoose.startSession();
    let result: any;
    try {
        await session.withTransaction(async () => {
            const approvedBom: any = await ProductionBom.findOne({
                plantId: order.plantId,
                itemId: order.itemId,
                status: 'approved',
            })
                .select('lines.materialId')
                .session(session)
                .lean();
            if (!approvedBom) throw new BadRequestError('Mã hàng chưa có BOM được duyệt');
            const materialIds: string[] = [
                ...new Set<string>((approvedBom.lines || []).map((line: any) => String(line.materialId))),
            ].sort();
            // Mọi lệnh giữ tồn cùng vật tư phải ghi lên cùng lock document. MongoDB
            // sẽ retry transaction khi hai planner thao tác đồng thời, tránh giữ vượt tồn.
            for (const materialId of materialIds) {
                await ProductionMaterialReservationLock.updateOne(
                    { plantId: order.plantId, materialId },
                    { $inc: { revision: 1 }, $setOnInsert: { plantId: order.plantId, materialId } },
                    { upsert: true, session }
                );
            }
            const before = (await loadReadinessRows(String(order.plantId), [String(order._id)], { session }))[0];
            if (!before?.bom) throw new BadRequestError('Mã hàng chưa có BOM được duyệt');
            for (const line of before.lines) {
                const quantity = calculateReservableQuantity({
                    requiredQuantity: line.requiredQuantity,
                    onHandQuantity: line.onHandQuantity,
                    reservedForOtherOrdersQuantity: line.reservedForOtherOrdersQuantity,
                });
                const existing: any = await ProductionMaterialReservation.findOne({
                    productionOrderId: order._id,
                    materialId: line.materialId,
                    status: 'active',
                }).session(session);
                if (existing) {
                    existing.quantity = quantity;
                    existing.bomId = before.bom.id;
                    existing.materialName = line.materialName;
                    existing.unit = line.unit;
                    existing.updatedBy = actor;
                    await existing.save({ session });
                } else if (quantity > 0) {
                    await ProductionMaterialReservation.create(
                        [
                            {
                                plantId: order.plantId,
                                productionOrderId: order._id,
                                productionOrderCode: order.code,
                                bomId: before.bom.id,
                                materialId: line.materialId,
                                materialName: line.materialName,
                                unit: line.unit,
                                quantity,
                                status: 'active',
                                createdBy: actor,
                                updatedBy: actor,
                            },
                        ],
                        { session }
                    );
                }
            }
            const after = (await loadReadinessRows(String(order.plantId), [String(order._id)], { session }))[0];
            const [snapshot] = await ProductionMaterialSnapshot.create(
                [snapshotPayload(String(order.plantId), after, actor)],
                { session }
            );
            result = {
                ...after,
                latestSnapshot: { id: String(snapshot._id), status: snapshot.status, asOf: toIso(snapshot.asOf) },
            };
        });
    } catch (error: any) {
        if (
            error?.code === 11000 ||
            error?.name === 'VersionError' ||
            error?.errorLabels?.includes?.('TransientTransactionError')
        ) {
            throw new DuplicateError('Tồn vật tư vừa được người khác giữ. Hãy đối chiếu lại trước khi thao tác');
        }
        throw error;
    } finally {
        await session.endSession();
    }
    emitToPlant(String(order.plantId), 'production:material-updated', {
        plantId: String(order.plantId),
        orderId: String(order._id),
    });
    return sendSuccess(res, result, 'Đã giữ tồn khả dụng và lưu snapshot readiness');
};

export const releaseProductionOrderMaterials = async (req: Request, res: Response) => {
    const order: any = await ProductionOrder.findById(req.params.id).lean();
    if (!order) throw new NotFoundError('Không tìm thấy đơn hàng sản xuất');
    assertPlantAccess(req, String(order.plantId));
    const actor = actorId(req);
    const session = await mongoose.startSession();
    let releasedCount = 0;
    let readiness: any;
    try {
        await session.withTransaction(async () => {
            const active: any[] = await ProductionMaterialReservation.find({
                productionOrderId: order._id,
                status: 'active',
            })
                .select('materialId')
                .session(session)
                .lean();
            const materialIds = [...new Set<string>(active.map((row) => String(row.materialId)))].sort();
            for (const materialId of materialIds) {
                await ProductionMaterialReservationLock.updateOne(
                    { plantId: order.plantId, materialId },
                    { $inc: { revision: 1 }, $setOnInsert: { plantId: order.plantId, materialId } },
                    { upsert: true, session }
                );
            }
            const result = await ProductionMaterialReservation.updateMany(
                { productionOrderId: order._id, status: 'active' },
                {
                    $set: {
                        status: 'released',
                        releasedAt: new Date(),
                        releasedBy: actor,
                        releaseReason: req.body.reason,
                        updatedBy: actor,
                    },
                },
                { session }
            );
            releasedCount = result.modifiedCount;
            const rows = await loadReadinessRows(String(order.plantId), [String(order._id)], { session });
            readiness = rows[0];
            if (readiness) {
                await ProductionMaterialSnapshot.create([snapshotPayload(String(order.plantId), readiness, actor)], {
                    session,
                });
            }
        });
    } catch (error: any) {
        if (error?.code === 11000 || error?.errorLabels?.includes?.('TransientTransactionError')) {
            throw new DuplicateError('Reservation vừa thay đổi. Hãy đối chiếu lại trước khi giải phóng');
        }
        throw error;
    } finally {
        await session.endSession();
    }
    emitToPlant(String(order.plantId), 'production:material-updated', {
        plantId: String(order.plantId),
        orderId: String(order._id),
    });
    return sendSuccess(res, { releasedCount, readiness }, 'Đã giải phóng tồn đã giữ');
};

export const snapshotProductionOrderReadiness = async (req: Request, res: Response) => {
    const order: any = await ProductionOrder.findById(req.params.id).lean();
    if (!order) throw new NotFoundError('Không tìm thấy đơn hàng sản xuất');
    assertPlantAccess(req, String(order.plantId));
    const row = (await loadReadinessRows(String(order.plantId), [String(order._id)]))[0];
    if (!row) throw new NotFoundError('Không tìm thấy readiness của đơn hàng');
    const snapshot = await ProductionMaterialSnapshot.create(snapshotPayload(String(order.plantId), row, actorId(req)));
    return sendSuccess(
        res,
        { id: String(snapshot._id), status: snapshot.status, asOf: toIso(snapshot.asOf) },
        'Đã lưu snapshot readiness'
    );
};

export { loadReadinessRows };
