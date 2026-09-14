import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionOrder from '@/models/ProductionOrder';
import ProductionPlan from '@/models/ProductionPlan';
import { vietnamIsoDate } from '@/utils/vietnamDate';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import {
    capacityMinutesForAllocation,
    reserveRegularCapacityWindow,
    type CapacitySlot,
} from './production-capacity.helpers';
import { buildProductionOrderProgress, synchronizeProductionOrderLifecycle } from './production-order.service';
import { loadReadinessRows } from './production-material.service';
import { normalizeProductionTimeSlots } from './production-schedule.helpers';
import { resolveProductionScheduleForDate } from './production-schedule.service';
import { sendSuccess } from './service.helpers';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR_SELECT = 'fullname username email';
const PLAN_ACTOR_PATHS = [
    { path: 'createdBy', select: ACTOR_SELECT },
    { path: 'updatedBy', select: ACTOR_SELECT },
    { path: 'publishedBy', select: ACTOR_SELECT },
    { path: 'reopenedBy', select: ACTOR_SELECT },
    { path: 'history.actor', select: ACTOR_SELECT },
];

const toId = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const toIso = (value: any): string | undefined => (value ? new Date(value).toISOString() : undefined);

const actorName = (value: any): string | undefined => {
    if (!value || typeof value === 'string') return undefined;
    return value.fullname || value.username || value.email || undefined;
};

const serializeActor = (value: any) => {
    const id = toId(value);
    return id ? { id, name: actorName(value) } : undefined;
};

const userPlantId = (req: Request): string => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền thao tác kế hoạch của cơ sở này');
    }
};

const resolvePlantId = (req: Request, value?: unknown): string => {
    const resolved = String(value || userPlantId(req) || '');
    if (!resolved) throw new BadRequestError('Cần chọn cơ sở');
    assertPlantAccess(req, resolved);
    return resolved;
};

const assertValidDate = (value: unknown): string => {
    const date = String(value || '');
    if (!DATE_PATTERN.test(date)) throw new BadRequestError('Ngày sản xuất không hợp lệ');
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new BadRequestError('Ngày sản xuất không hợp lệ');
    }
    return date;
};

export const serializeProductionPlan = (input: any) => {
    const plan = typeof input?.toObject === 'function' ? input.toObject() : input;
    const allocations = (plan.allocations || []).map((allocation: any) => ({
        id: toId(allocation),
        lineId: toId(allocation.lineId),
        lineCode: allocation.lineCode,
        lineName: allocation.lineName,
        itemId: toId(allocation.itemId),
        itemCode: allocation.itemCode,
        itemName: allocation.itemName,
        unit: allocation.unit || 'SP',
        unitPriceSnapshot: Number(allocation.unitPriceSnapshot || 0),
        orderId: toId(allocation.orderId),
        orderCode: allocation.orderCode,
        plannedQuantity: Number(allocation.plannedQuantity || 0),
        hourlyQuota: Number(allocation.hourlyQuota || 0),
        startSlotKey: allocation.startSlotKey,
        endSlotKey: allocation.endSlotKey,
        priority: allocation.priority || 'normal',
        dueDate: allocation.dueDate,
        note: allocation.note,
        sourceType: allocation.sourceType || 'manual',
        sourcePlanId: toId(allocation.sourcePlanId),
        sourceAllocationId: toId(allocation.sourceAllocationId),
        sourceProductionDate: allocation.sourceProductionDate,
    }));
    return {
        id: toId(plan),
        plantId: toId(plan.plantId),
        plantName: plan.plantName,
        plantCode: plan.plantCode,
        productionDate: plan.productionDate,
        status: plan.status || 'draft',
        revision: Number(plan.revision || 0),
        scheduleSource: plan.scheduleSource || 'legacy',
        scheduleWeekday: Number.isInteger(plan.scheduleWeekday) ? Number(plan.scheduleWeekday) : undefined,
        scheduleRevision: Number(plan.scheduleRevision || 0),
        timeSlots: [...(plan.timeSlots || [])]
            .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute))
            .map((slot: any) => ({
                key: slot.key,
                label: slot.label,
                startMinute: Number(slot.startMinute),
                endMinute: Number(slot.endMinute),
                kind: slot.kind || 'regular',
                isActive: slot.isActive !== false,
            })),
        allocations,
        summary: {
            allocationCount: allocations.length,
            lineCount: new Set(allocations.map((allocation: any) => allocation.lineId)).size,
            itemCount: new Set(allocations.map((allocation: any) => allocation.itemId)).size,
            totalPlannedQuantity: allocations.reduce(
                (sum: number, allocation: any) => sum + allocation.plannedQuantity,
                0
            ),
            carryOverQuantity: allocations
                .filter((allocation: any) => allocation.sourceType === 'carry_over')
                .reduce((sum: number, allocation: any) => sum + allocation.plannedQuantity, 0),
        },
        publishedAt: toIso(plan.publishedAt),
        publishedBy: serializeActor(plan.publishedBy),
        reopenedAt: toIso(plan.reopenedAt),
        reopenedBy: serializeActor(plan.reopenedBy),
        lastChangeReason: plan.lastChangeReason,
        history: (plan.history || []).map((event: any) => ({
            id: toId(event),
            type: event.type,
            note: event.note,
            revision: Number(event.revision || 0),
            actor: serializeActor(event.actor),
            at: toIso(event.at),
        })),
        createdBy: serializeActor(plan.createdBy),
        updatedBy: serializeActor(plan.updatedBy),
        createdAt: toIso(plan.createdAt),
        updatedAt: toIso(plan.updatedAt),
    };
};

const populatePlan = async (plan: any) => {
    await plan.populate(PLAN_ACTOR_PATHS);
    return plan;
};

const loadPlan = async (req: Request, planId: string, session?: mongoose.ClientSession) => {
    const query = ProductionPlan.findById(planId);
    if (session) query.session(session);
    const plan: any = await query;
    if (!plan) throw new NotFoundError('Không tìm thấy kế hoạch sản xuất');
    assertPlantAccess(req, String(plan.plantId));
    return plan;
};

const assertDraft = (plan: any) => {
    if (plan.status !== 'draft') throw new BadRequestError('Cần mở lại kế hoạch trước khi chỉnh sửa');
};

const assertRevision = (plan: any, revision: unknown) => {
    if (Number(revision) !== Number(plan.revision || 0)) {
        throw new DuplicateError('Kế hoạch vừa được cập nhật ở thiết bị khác, vui lòng tải lại');
    }
};

const savePlan = async (plan: any, session?: mongoose.ClientSession) => {
    try {
        return await plan.save(session ? { session } : undefined);
    } catch (error: any) {
        if (error?.name === 'VersionError') {
            throw new DuplicateError('Kế hoạch vừa được cập nhật ở thiết bị khác, vui lòng tải lại');
        }
        throw error;
    }
};

const emitPlanUpdated = (plan: any, changeType: string) => {
    emitToPlant(String(plan.plantId), 'production:plan-updated', {
        planId: String(plan._id),
        plantId: String(plan.plantId),
        productionDate: plan.productionDate,
        revision: Number(plan.revision || 0),
        status: plan.status,
        changeType,
        at: new Date().toISOString(),
    });
};

const resolvedTimeSlots = async (plantId: string, productionDate: string) => {
    const sameDay: any = await ProductionDay.findOne({ plantId, productionDate })
        .select('timeSlots scheduleWeekday scheduleRevision')
        .lean();
    if (sameDay?.timeSlots?.length) {
        return {
            timeSlots: sameDay.timeSlots.map((slot: any) => ({ ...slot })),
            source: 'day_snapshot' as const,
            weekday: Number.isInteger(sameDay.scheduleWeekday)
                ? Number(sameDay.scheduleWeekday)
                : new Date(`${productionDate}T00:00:00.000Z`).getUTCDay(),
            revision: Number(sameDay.scheduleRevision || 0),
        };
    }
    return resolveProductionScheduleForDate(plantId, productionDate);
};

const normalizeAllocations = async (plan: any, inputs: any[], session?: mongoose.ClientSession) => {
    const lineIds = [...new Set(inputs.map((input) => String(input.lineId)))];
    const itemIds = [...new Set(inputs.map((input) => String(input.itemId)))];
    const lineQuery = ProductionLine.find({ _id: { $in: lineIds }, plantId: plan.plantId, isActive: true }).lean();
    const itemQuery = ProductionItem.find({ _id: { $in: itemIds }, plantId: plan.plantId, isActive: true }).lean();
    const orderIds = [...new Set(inputs.map((input) => String(input.orderId || '')).filter(Boolean))];
    const orderCodes = [
        ...new Set(
            inputs
                .map((input) =>
                    String(input.orderCode || '')
                        .trim()
                        .toUpperCase()
                )
                .filter(Boolean)
        ),
    ];
    const orderReferences = [
        ...(orderIds.length ? [{ _id: { $in: orderIds } }] : []),
        ...(orderCodes.length ? [{ code: { $in: orderCodes } }] : []),
    ];
    const orderQuery = ProductionOrder.find(
        orderReferences.length ? { plantId: plan.plantId, $or: orderReferences } : { _id: { $in: [] } }
    ).lean();
    if (session) {
        lineQuery.session(session);
        itemQuery.session(session);
        orderQuery.session(session);
    }
    const [lines, items, orders] = session
        ? [await lineQuery, await itemQuery, await orderQuery]
        : await Promise.all([lineQuery, itemQuery, orderQuery]);
    const lineById = new Map<string, any>(lines.map((line: any) => [String(line._id), line]));
    const itemById = new Map<string, any>(items.map((item: any) => [String(item._id), item]));
    const orderById = new Map<string, any>(orders.map((order: any) => [String(order._id), order]));
    const orderByCode = new Map<string, any>(orders.map((order: any) => [String(order.code).toUpperCase(), order]));
    const activeSlots = [...plan.timeSlots]
        .filter((slot: any) => slot.isActive !== false)
        .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute));
    const slotIndex = new Map<string, number>(activeSlots.map((slot: any, index: number) => [String(slot.key), index]));
    const existingById = new Map<string, any>(
        (plan.allocations || []).map((allocation: any) => [String(allocation._id), allocation])
    );
    const seenIds = new Set<string>();

    const normalized = inputs.map((input) => {
        const line: any = lineById.get(String(input.lineId));
        const item: any = itemById.get(String(input.itemId));
        if (!line) throw new NotFoundError('Chuyền trong kế hoạch không còn hoạt động');
        if (!item) throw new NotFoundError('Mã hàng trong kế hoạch không còn hoạt động');
        const requestedOrder = input.orderId
            ? orderById.get(String(input.orderId))
            : orderByCode.get(
                  String(input.orderCode || '')
                      .trim()
                      .toUpperCase()
              );
        if (input.orderId && !requestedOrder) throw new NotFoundError('Đơn hàng trong kế hoạch không tồn tại');
        if (requestedOrder && ['completed', 'cancelled'].includes(requestedOrder.status)) {
            throw new BadRequestError(`Đơn hàng ${requestedOrder.code} đã kết thúc, không thể tiếp tục phân bổ`);
        }
        if (requestedOrder && String(requestedOrder.itemId) !== String(item._id)) {
            throw new BadRequestError(`Đơn hàng ${requestedOrder.code} không thuộc mã hàng ${item.code}`);
        }
        const startIndex = slotIndex.get(String(input.startSlotKey));
        const endIndex = slotIndex.get(String(input.endSlotKey));
        if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
            throw new BadRequestError(`Khoảng giờ của ${line.code} - ${item.code} không hợp lệ`);
        }
        const existing = input.id ? existingById.get(String(input.id)) : undefined;
        if (input.id && !existing) throw new BadRequestError('Phân bổ không thuộc kế hoạch này');
        const id = existing?._id || new mongoose.Types.ObjectId();
        if (seenIds.has(String(id))) throw new BadRequestError('Phân bổ bị trùng');
        seenIds.add(String(id));
        return {
            _id: id,
            lineId: line._id,
            lineCode: line.code,
            lineName: line.name,
            itemId: item._id,
            itemCode: item.code,
            itemName: item.name,
            unit: item.unit || 'SP',
            unitPriceSnapshot: Number(item.unitPrice || 0),
            orderId: requestedOrder?._id,
            orderCode: requestedOrder?.code || input.orderCode || undefined,
            plannedQuantity: Number(input.plannedQuantity),
            hourlyQuota: Number(input.hourlyQuota),
            startSlotKey: input.startSlotKey,
            endSlotKey: input.endSlotKey,
            priority: input.priority || 'normal',
            dueDate: input.dueDate || plan.productionDate,
            note: input.note || undefined,
            sourceType: existing?.sourceType || 'manual',
            sourcePlanId: existing?.sourcePlanId,
            sourceAllocationId: existing?.sourceAllocationId,
            sourceProductionDate: existing?.sourceProductionDate,
        };
    });

    const byLine = new Map<string, any[]>();
    normalized.forEach((allocation) => {
        const key = String(allocation.lineId);
        const current = byLine.get(key) || [];
        current.push(allocation);
        byLine.set(key, current);
    });
    byLine.forEach((allocations) => {
        allocations.sort(
            (left, right) => Number(slotIndex.get(left.startSlotKey)) - Number(slotIndex.get(right.startSlotKey))
        );
        for (let index = 1; index < allocations.length; index += 1) {
            const previousEnd = Number(slotIndex.get(allocations[index - 1].endSlotKey));
            const currentStart = Number(slotIndex.get(allocations[index].startSlotKey));
            if (currentStart <= previousEnd) {
                throw new BadRequestError(
                    `Kế hoạch ${allocations[index].lineCode} bị chồng khung giờ giữa ${allocations[index - 1].itemCode} và ${allocations[index].itemCode}`
                );
            }
        }
    });

    const referencedOrders = orders.filter((order: any) =>
        normalized.some((allocation) => String(allocation.orderId || '') === String(order._id))
    );
    if (referencedOrders.length) {
        const progressByOrder = await buildProductionOrderProgress(String(plan.plantId), referencedOrders);
        const plannedByOrder = new Map<string, number>();
        normalized.forEach((allocation) => {
            if (!allocation.orderId) return;
            const key = String(allocation.orderId);
            plannedByOrder.set(key, (plannedByOrder.get(key) || 0) + Number(allocation.plannedQuantity || 0));
        });
        referencedOrders.forEach((order: any) => {
            const orderId = String(order._id);
            const requested = plannedByOrder.get(orderId) || 0;
            const available = Number(progressByOrder.get(orderId)?.unplannedQuantity || 0);
            if (requested > available) {
                throw new BadRequestError(
                    `Đơn hàng ${order.code} chỉ còn ${available} SP chưa xếp kế hoạch, không thể phân bổ ${requested} SP`
                );
            }
        });
    }
    return normalized;
};

// onlyLineIds = chỉ tạo bản ghi cho những chuyền kế hoạch thực sự giao việc.
// Bỏ trống (ngày vừa được publish tạo mới) thì lấy cả biên chế chuyền đang bật.
// Không được nhồi cả danh mục vào một ngày đã tồn tại: biên chế chuyền chốt theo ngày.
const ensureDayLineRecords = async (day: any, onlyLineIds?: Set<string>, session?: mongoose.ClientSession) => {
    const lineQuery = ProductionLine.find({ plantId: day.plantId, isActive: true })
        .sort({ sortOrder: 1, code: 1 })
        .lean();
    if (session) lineQuery.session(session);
    const allLines = await lineQuery;
    const lines = onlyLineIds ? allLines.filter((line: any) => onlyLineIds.has(String(line._id))) : allLines;
    if (!lines.length) return;
    await ProductionLineRecord.bulkWrite(
        lines.map((line: any) => ({
            updateOne: {
                filter: { dayId: day._id, lineId: line._id },
                update: {
                    $setOnInsert: {
                        dayId: day._id,
                        plantId: day.plantId,
                        productionDate: day.productionDate,
                        lineId: line._id,
                        lineCode: line.code,
                        lineName: line.name,
                        leaderName: line.leaderName,
                        sortOrder: line.sortOrder ?? 0,
                        workerCount: 0,
                        runs: [],
                        entries: [],
                        qcEntries: [],
                    },
                },
                upsert: true,
            },
        })) as any,
        { ordered: false, ...(session ? { session } : {}) }
    );
    if (!onlyLineIds) {
        await ProductionDay.updateOne(
            { _id: day._id },
            { $set: { lineRosterSeededAt: new Date() } },
            session ? { session } : undefined
        );
        day.lineRosterSeededAt = new Date();
    }
};

const ensureProductionDay = async (plan: any, actorId: string, session?: mongoose.ClientSession) => {
    const dayQuery = ProductionDay.findOne({ plantId: plan.plantId, productionDate: plan.productionDate });
    if (session) dayQuery.session(session);
    let day: any = await dayQuery;
    const isNewDay = !day;
    if (!day) {
        try {
            const created = await ProductionDay.create(
                [
                    {
                        plantId: plan.plantId,
                        plantName: plan.plantName,
                        plantCode: plan.plantCode,
                        productionDate: plan.productionDate,
                        timeSlots: plan.timeSlots.map((slot: any) => ({ ...(slot.toObject?.() ?? slot) })),
                        scheduleSource: 'plan_snapshot',
                        scheduleWeekday: plan.scheduleWeekday,
                        scheduleRevision: plan.scheduleRevision,
                        createdBy: actorId,
                        updatedBy: actorId,
                    },
                ],
                session ? { session } : undefined
            );
            day = created[0];
        } catch (error: any) {
            if (error?.code === 11000) {
                const existingQuery = ProductionDay.findOne({
                    plantId: plan.plantId,
                    productionDate: plan.productionDate,
                });
                if (session) existingQuery.session(session);
                day = await existingQuery;
            } else {
                throw error;
            }
        }
    }
    if (!day) throw new DuplicateError('Không thể khởi tạo ngày sản xuất');
    if (day.status !== 'draft') throw new BadRequestError('Ngày sản xuất đã gửi duyệt hoặc khóa sổ');
    const dayKeys = new Set(day.timeSlots.filter((slot: any) => slot.isActive).map((slot: any) => String(slot.key)));
    const invalidAllocation = plan.allocations.find(
        (allocation: any) => !dayKeys.has(allocation.startSlotKey) || !dayKeys.has(allocation.endSlotKey)
    );
    if (invalidAllocation) {
        throw new BadRequestError(
            `Khung giờ của ${invalidAllocation.lineCode} - ${invalidAllocation.itemCode} không còn tồn tại trong sổ sản xuất`
        );
    }
    await ensureDayLineRecords(
        day,
        isNewDay ? undefined : new Set(plan.allocations.map((allocation: any) => String(allocation.lineId))),
        session
    );
    return day;
};

const runFromAllocation = (allocation: any, actorId: string) => ({
    itemId: allocation.itemId,
    itemCode: allocation.itemCode,
    itemName: allocation.itemName,
    unit: allocation.unit || 'SP',
    unitPriceSnapshot: allocation.unitPriceSnapshot || 0,
    hourlyQuota: allocation.hourlyQuota,
    startedSlotKey: allocation.startSlotKey,
    endedSlotKey: allocation.endSlotKey,
    plannedEndSlotKey: allocation.endSlotKey,
    status: 'planned',
    source: 'plan',
    planAllocationId: allocation._id,
    plannedQuantity: allocation.plannedQuantity,
    orderId: allocation.orderId,
    orderCode: allocation.orderCode,
    priority: allocation.priority,
    dueDate: allocation.dueDate,
    createdBy: actorId,
    createdAt: new Date(),
});

const applyPlanToDay = async (plan: any, actorId: string, session?: mongoose.ClientSession) => {
    const day = await ensureProductionDay(plan, actorId, session);
    const recordQuery = ProductionLineRecord.find({ dayId: day._id });
    if (session) recordQuery.session(session);
    const records: any[] = await recordQuery;
    const allocationsByLine = new Map<string, any[]>();
    plan.allocations.forEach((allocation: any) => {
        const key = String(allocation.lineId);
        const current = allocationsByLine.get(key) || [];
        current.push(allocation);
        allocationsByLine.set(key, current);
    });
    const slotIndex = new Map(day.timeSlots.map((slot: any, index: number) => [String(slot.key), index]));
    let synchronizedLines = 0;
    const preservedLines: string[] = [];

    for (const record of records) {
        const allocations = (allocationsByLine.get(String(record.lineId)) || []).sort(
            (left, right) => Number(slotIndex.get(left.startSlotKey)) - Number(slotIndex.get(right.startSlotKey))
        );
        // Kết quả QC độc lập với mã hàng/kế hoạch đang chạy, nên không được
        // dùng để giữ hoặc khóa các run của kế hoạch sản xuất.
        const recordedEntries = [...record.entries];
        if (!recordedEntries.length) {
            if (allocations.length) {
                record.set(
                    'runs',
                    allocations.map((allocation) => runFromAllocation(allocation, actorId))
                );
                synchronizedLines += 1;
            } else {
                // Chuyền không nằm trong kế hoạch: chỉ gỡ runs do bản plan trước sinh ra,
                // giữ nguyên mã hàng + khoán mà tổ trưởng đã cấu hình thủ công đầu ngày.
                record.set(
                    'runs',
                    record.runs.filter((run: any) => run.source !== 'plan')
                );
            }
        } else {
            const entryRunIds = new Set(recordedEntries.map((entry: any) => String(entry.runId)));
            const allocationIds = new Set(allocations.map((allocation) => String(allocation._id)));
            record.runs = record.runs.filter(
                (run: any) =>
                    run.source !== 'plan' ||
                    entryRunIds.has(String(run._id)) ||
                    allocationIds.has(String(run.planAllocationId))
            );
            const latestEnteredIndex = Math.max(
                -1,
                ...recordedEntries.map((entry: any) => Number(slotIndex.get(String(entry.slotKey)) ?? -1))
            );
            let skipped = false;
            allocations.forEach((allocation) => {
                const existing = record.runs.find(
                    (run: any) => String(run.planAllocationId) === String(allocation._id)
                );
                if (existing) {
                    existing.plannedQuantity = allocation.plannedQuantity;
                    existing.orderId = allocation.orderId;
                    existing.orderCode = allocation.orderCode;
                    existing.priority = allocation.priority;
                    existing.dueDate = allocation.dueDate;
                    if (!entryRunIds.has(String(existing._id))) {
                        Object.assign(existing, runFromAllocation(allocation, actorId));
                    }
                    return;
                }
                if (Number(slotIndex.get(allocation.startSlotKey)) <= latestEnteredIndex) {
                    skipped = true;
                    return;
                }
                record.runs.push(runFromAllocation(allocation, actorId));
            });
            if (skipped) preservedLines.push(record.lineCode);
            else if (allocations.length) synchronizedLines += 1;
        }
        record.updatedBy = actorId;
        await record.save(session ? { session } : undefined);
    }
    day.updatedBy = actorId;
    await day.save(session ? { session } : undefined);
    return { dayId: String(day._id), synchronizedLines, preservedLines };
};

type MasterPlanSuggestionInput = {
    orderId: string;
    date: string;
    lineId: string;
    quantity: number;
    hourlyQuota: number;
};

type MasterPlanPreviewRow = MasterPlanSuggestionInput & {
    key: string;
    orderCode?: string;
    itemId?: string;
    itemCode?: string;
    lineCode?: string;
    status: 'ready' | 'blocked';
    reasonCode?:
        | 'past_date'
        | 'order_missing'
        | 'order_closed'
        | 'line_missing'
        | 'item_missing'
        | 'published_plan'
        | 'invalid_existing_plan'
        | 'order_capacity'
        | 'material_shortage'
        | 'material_not_reserved'
        | 'plan_limit'
        | 'no_contiguous_slot';
    message: string;
    startSlotKey?: string;
    endSlotKey?: string;
    requiredMinutes?: number;
    reservedMinutes?: number;
    planStatus?: 'draft' | 'published';
    planRevision: number;
    orderRevision: number;
    willCreatePlan: boolean;
};

type MasterPlanState = {
    document?: any;
    timeSlots: CapacitySlot[];
    scheduleSource: string;
    scheduleWeekday: number;
    scheduleRevision: number;
};

const masterSuggestionKey = (suggestion: MasterPlanSuggestionInput) =>
    `${suggestion.orderId}|${suggestion.date}|${suggestion.lineId}`;

const masterPreviewFingerprint = (plantId: string, rows: MasterPlanPreviewRow[]) =>
    createHash('sha256')
        .update(
            JSON.stringify({
                plantId,
                rows: rows.map((row) => ({
                    key: row.key,
                    quantity: row.quantity,
                    hourlyQuota: row.hourlyQuota,
                    status: row.status,
                    reasonCode: row.reasonCode,
                    startSlotKey: row.startSlotKey,
                    endSlotKey: row.endSlotKey,
                    planRevision: row.planRevision,
                    orderRevision: row.orderRevision,
                })),
            })
        )
        .digest('hex');

const buildMasterPlanPreview = async (
    req: Request,
    inputs: MasterPlanSuggestionInput[],
    session?: mongoose.ClientSession
) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const today = vietnamIsoDate();
    const suggestions = [...inputs].sort(
        (left, right) =>
            left.date.localeCompare(right.date) ||
            left.lineId.localeCompare(right.lineId) ||
            left.orderId.localeCompare(right.orderId)
    );
    const orderIds = [...new Set(suggestions.map((row) => row.orderId))];
    const lineIds = [...new Set(suggestions.map((row) => row.lineId))];
    const dates = [...new Set(suggestions.map((row) => row.date))];

    const plantQuery: any = Plant.findOne({ _id: plantId, isDeleted: { $ne: true } }).select('name code');
    const orderQuery: any = ProductionOrder.find({ _id: { $in: orderIds }, plantId });
    const lineQuery: any = ProductionLine.find({ _id: { $in: lineIds }, plantId, isActive: true });
    const planQuery: any = ProductionPlan.find({ plantId, productionDate: { $in: dates } });
    if (session) {
        [plantQuery, orderQuery, lineQuery, planQuery].forEach((query) => query.session(session));
    }
    const [plant, orders, lines, plans]: [any, any[], any[], any[]] = session
        ? [await plantQuery, await orderQuery, await lineQuery, await planQuery]
        : await Promise.all([plantQuery, orderQuery, lineQuery, planQuery]);
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');

    const itemIds = [...new Set(orders.map((order) => String(order.itemId)))];
    const orderCodes = [...new Set(orders.map((order) => String(order.code).trim().toUpperCase()))];
    const itemQuery: any = ProductionItem.find({ _id: { $in: itemIds }, plantId, isActive: true });
    const draftPlanQuery: any = ProductionPlan.find({
        plantId,
        status: 'draft',
        $or: [{ 'allocations.orderId': { $in: orderIds } }, { 'allocations.orderCode': { $in: orderCodes } }],
    }).select('productionDate allocations');
    if (session) {
        itemQuery.session(session);
        draftPlanQuery.session(session);
    }
    const [items, draftPlans]: [any[], any[]] = session
        ? [await itemQuery, await draftPlanQuery]
        : await Promise.all([itemQuery, draftPlanQuery]);

    const orderById = new Map(orders.map((order) => [String(order._id), order]));
    const orderByCode = new Map(orders.map((order) => [String(order.code).trim().toUpperCase(), order]));
    const lineById = new Map(lines.map((line) => [String(line._id), line]));
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const progressByOrder = await buildProductionOrderProgress(plantId, orders);
    const materialReadiness = await loadReadinessRows(plantId, orderIds, { session });
    const materialByOrder = new Map(materialReadiness.map((row) => [row.order.id, row]));
    const draftQuantityByOrder = new Map<string, number>();
    draftPlans.forEach((plan) => {
        (plan.allocations || []).forEach((allocation: any) => {
            const orderId = allocation.orderId
                ? String(allocation.orderId)
                : String(
                      orderByCode.get(
                          String(allocation.orderCode || '')
                              .trim()
                              .toUpperCase()
                      )?._id || ''
                  );
            if (!orderById.has(orderId)) return;
            draftQuantityByOrder.set(
                orderId,
                (draftQuantityByOrder.get(orderId) || 0) + Number(allocation.plannedQuantity || 0)
            );
        });
    });
    const availableByOrder = new Map(
        orders.map((order) => {
            const orderId = String(order._id);
            return [
                orderId,
                Math.max(
                    0,
                    Number(progressByOrder.get(orderId)?.unplannedQuantity || 0) -
                        Number(draftQuantityByOrder.get(orderId) || 0)
                ),
            ];
        })
    );

    const planByDate = new Map(plans.map((plan) => [String(plan.productionDate), plan]));
    const planStateByDate = new Map<string, MasterPlanState>();
    for (const date of dates) {
        const plan: any = planByDate.get(date);
        if (plan) {
            planStateByDate.set(date, {
                document: plan,
                timeSlots: normalizeProductionTimeSlots(plan.timeSlots) as CapacitySlot[],
                scheduleSource: plan.scheduleSource || 'legacy',
                scheduleWeekday: Number(plan.scheduleWeekday || 0),
                scheduleRevision: Number(plan.scheduleRevision || 0),
            });
            continue;
        }
        const schedule = await resolvedTimeSlots(plantId, date);
        planStateByDate.set(date, {
            timeSlots: normalizeProductionTimeSlots(schedule.timeSlots) as CapacitySlot[],
            scheduleSource: schedule.source,
            scheduleWeekday: schedule.weekday,
            scheduleRevision: schedule.revision,
        });
    }

    const occupiedByCell = new Map<string, Array<{ startSlotKey: string; endSlotKey: string }>>();
    const invalidPlanDates = new Set<string>();
    planStateByDate.forEach((state, date) => {
        (state.document?.allocations || []).forEach((allocation: any) => {
            const minutes = capacityMinutesForAllocation(
                state.timeSlots,
                String(allocation.startSlotKey),
                String(allocation.endSlotKey)
            );
            if (!minutes.valid) invalidPlanDates.add(date);
            const cellKey = `${date}|${allocation.lineId}`;
            const windows = occupiedByCell.get(cellKey) || [];
            windows.push({
                startSlotKey: String(allocation.startSlotKey),
                endSlotKey: String(allocation.endSlotKey),
            });
            occupiedByCell.set(cellKey, windows);
        });
    });
    const addedCountByDate = new Map<string, number>();

    const rows: MasterPlanPreviewRow[] = suggestions.map((suggestion) => {
        const key = masterSuggestionKey(suggestion);
        const order: any = orderById.get(suggestion.orderId);
        const line: any = lineById.get(suggestion.lineId);
        const item: any = order ? itemById.get(String(order.itemId)) : undefined;
        const state = planStateByDate.get(suggestion.date)!;
        const base: Omit<MasterPlanPreviewRow, 'status' | 'message'> = {
            ...suggestion,
            key,
            orderCode: order?.code,
            itemId: item ? String(item._id) : undefined,
            itemCode: item?.code,
            lineCode: line?.code,
            planStatus: state.document?.status,
            planRevision: Number(state.document?.revision || 0),
            orderRevision: Number(order?.revision || 0),
            willCreatePlan: !state.document,
        };
        const blocked = (reasonCode: MasterPlanPreviewRow['reasonCode'], message: string): MasterPlanPreviewRow => ({
            ...base,
            status: 'blocked',
            reasonCode,
            message,
        });
        if (suggestion.date < today) return blocked('past_date', 'Ngày đề xuất đã qua');
        if (!order) return blocked('order_missing', 'Đơn hàng không còn tồn tại tại cơ sở');
        if (['completed', 'cancelled'].includes(order.status)) {
            return blocked('order_closed', `Đơn ${order.code} đã kết thúc`);
        }
        if (!line) return blocked('line_missing', 'Chuyền không còn hoạt động tại cơ sở');
        if (!item) return blocked('item_missing', `Mã hàng của đơn ${order.code} không còn hoạt động`);
        const materials = materialByOrder.get(suggestion.orderId);
        if (materials?.bom && ['shortage', 'partial'].includes(materials.status)) {
            return blocked(
                'material_shortage',
                `Đơn ${order.code} còn thiếu ${materials.summary.shortageLineCount} vật tư bắt buộc`
            );
        }
        if (materials?.bom && materials.reservationStatus !== 'reserved') {
            return blocked(
                'material_not_reserved',
                `Đơn ${order.code} chưa giữ đủ tồn; cần xác nhận tại màn Nguyên phụ liệu`
            );
        }
        if (state.document?.status === 'published') {
            return blocked('published_plan', 'Kế hoạch ngày đã ban hành, cần mở lại trước khi điều chỉnh');
        }
        if (invalidPlanDates.has(suggestion.date)) {
            return blocked('invalid_existing_plan', 'Kế hoạch ngày có phân bổ dùng khung giờ không còn hợp lệ');
        }
        const currentCount =
            Number(state.document?.allocations?.length || 0) + Number(addedCountByDate.get(suggestion.date) || 0);
        if (currentCount >= 200) return blocked('plan_limit', 'Kế hoạch ngày đã đạt giới hạn 200 phân bổ');
        const availableQuantity = Number(availableByOrder.get(suggestion.orderId) || 0);
        if (suggestion.quantity > availableQuantity) {
            return blocked(
                'order_capacity',
                `Đơn ${order.code} chỉ còn ${Math.floor(availableQuantity)} SP chưa được xếp`
            );
        }
        const configuredRate = Number(item.planningHourlyQuota || 0);
        const hourlyQuota = configuredRate > 0 ? configuredRate : Number(suggestion.hourlyQuota || 0);
        const requiredMinutes = (suggestion.quantity * 60) / hourlyQuota;
        const cellKey = `${suggestion.date}|${suggestion.lineId}`;
        const occupiedWindows = occupiedByCell.get(cellKey) || [];
        const reserved = reserveRegularCapacityWindow({
            slots: state.timeSlots,
            occupiedWindows,
            requiredMinutes,
        });
        if (!reserved) {
            return blocked(
                'no_contiguous_slot',
                'Không còn dải giờ thường liền mạch đủ dài; cần xếp thủ công hoặc xem xét tăng ca'
            );
        }
        occupiedWindows.push({ startSlotKey: reserved.startSlotKey, endSlotKey: reserved.endSlotKey });
        occupiedByCell.set(cellKey, occupiedWindows);
        availableByOrder.set(suggestion.orderId, Math.max(0, availableQuantity - suggestion.quantity));
        addedCountByDate.set(suggestion.date, Number(addedCountByDate.get(suggestion.date) || 0) + 1);
        return {
            ...base,
            hourlyQuota,
            status: 'ready',
            message: state.document ? 'Sẵn sàng bổ sung vào kế hoạch nháp' : 'Sẵn sàng tạo kế hoạch nháp mới',
            startSlotKey: reserved.startSlotKey,
            endSlotKey: reserved.endSlotKey,
            requiredMinutes: Number(requiredMinutes.toFixed(2)),
            reservedMinutes: reserved.reservedMinutes,
        };
    });
    const fingerprint = masterPreviewFingerprint(plantId, rows);
    const readyRows = rows.filter((row) => row.status === 'ready');
    const blockedRows = rows.filter((row) => row.status === 'blocked');
    return {
        response: {
            fingerprint,
            generatedAt: new Date().toISOString(),
            summary: {
                selectedCount: rows.length,
                readyCount: readyRows.length,
                blockedCount: blockedRows.length,
                readyQuantity: readyRows.reduce((sum, row) => sum + row.quantity, 0),
                affectedDayCount: new Set(readyRows.map((row) => row.date)).size,
            },
            rows,
        },
        context: { plantId, plant, orderById, planStateByDate },
    };
};

const allocationPayload = (allocation: any) => ({
    id: String(allocation._id),
    lineId: String(allocation.lineId),
    itemId: String(allocation.itemId),
    orderId: allocation.orderId ? String(allocation.orderId) : undefined,
    orderCode: allocation.orderCode,
    plannedQuantity: Number(allocation.plannedQuantity),
    hourlyQuota: Number(allocation.hourlyQuota),
    startSlotKey: allocation.startSlotKey,
    endSlotKey: allocation.endSlotKey,
    priority: allocation.priority,
    dueDate: allocation.dueDate,
    note: allocation.note,
});

export const applyProductionMasterPlan = async (req: Request, res: Response) => {
    const suggestions = req.body.suggestions as MasterPlanSuggestionInput[];
    if (!req.body.confirm) {
        const preview = await buildMasterPlanPreview(req, suggestions);
        return sendSuccess(res, preview.response, 'Đã kiểm tra phương án với dữ liệu kế hoạch hiện tại');
    }

    const session = await mongoose.startSession();
    let applied:
        | { plantId: string; planIds: string[]; orderIds: string[]; quantity: number; allocationCount: number }
        | undefined;
    try {
        await session.withTransaction(async () => {
            const preview = await buildMasterPlanPreview(req, suggestions, session);
            if (preview.response.fingerprint !== req.body.expectedFingerprint) {
                throw new DuplicateError('Phương án đã thay đổi do dữ liệu vừa được cập nhật, vui lòng kiểm tra lại');
            }
            if (preview.response.summary.blockedCount) {
                throw new BadRequestError('Phương án còn dòng bị chặn, vui lòng chỉ áp dụng các dòng sẵn sàng');
            }
            const rows = preview.response.rows;
            const rowsByDate = new Map<string, MasterPlanPreviewRow[]>();
            rows.forEach((row) => {
                const current = rowsByDate.get(row.date) || [];
                current.push(row);
                rowsByDate.set(row.date, current);
            });
            const planIds: string[] = [];
            for (const [date, dateRows] of rowsByDate) {
                const state = preview.context.planStateByDate.get(date)!;
                const isNew = !state.document;
                const plan: any =
                    state.document ||
                    new ProductionPlan({
                        plantId: preview.context.plantId,
                        plantName: preview.context.plant.name,
                        plantCode: preview.context.plant.code,
                        productionDate: date,
                        timeSlots: state.timeSlots,
                        scheduleSource: state.scheduleSource,
                        scheduleWeekday: state.scheduleWeekday,
                        scheduleRevision: state.scheduleRevision,
                        createdBy: req.userId,
                        updatedBy: req.userId,
                        history: [{ type: 'created', revision: 0, actor: req.userId, at: new Date() }],
                    });
                assertDraft(plan);
                const existingInputs = (plan.allocations || []).map(allocationPayload);
                const newInputs = dateRows.map((row) => {
                    const order: any = preview.context.orderById.get(row.orderId);
                    return {
                        lineId: row.lineId,
                        itemId: String(order.itemId),
                        orderId: row.orderId,
                        orderCode: order.code,
                        plannedQuantity: row.quantity,
                        hourlyQuota: row.hourlyQuota,
                        startSlotKey: row.startSlotKey,
                        endSlotKey: row.endSlotKey,
                        priority: order.priority,
                        dueDate: order.dueDate,
                        note: 'Xếp từ kế hoạch tổng thể',
                    };
                });
                plan.allocations = (await normalizeAllocations(
                    plan,
                    [...existingInputs, ...newInputs],
                    session
                )) as any;
                plan.revision = Number(plan.revision || 0) + 1;
                plan.lastChangeReason = `Xếp ${dateRows.length} phân bổ từ kế hoạch tổng thể`;
                plan.updatedBy = req.userId;
                plan.history.push({
                    type: 'updated',
                    note: plan.lastChangeReason,
                    revision: plan.revision,
                    actor: req.userId,
                    at: new Date(),
                });
                await savePlan(plan, session);
                planIds.push(String(plan._id));
                if (isNew) state.document = plan;
            }

            const orderRows = new Map<string, MasterPlanPreviewRow[]>();
            rows.forEach((row) => {
                const current = orderRows.get(row.orderId) || [];
                current.push(row);
                orderRows.set(row.orderId, current);
            });
            for (const [orderId, orderAllocations] of orderRows) {
                const order: any = preview.context.orderById.get(orderId);
                const quantity = orderAllocations.reduce((sum, row) => sum + row.quantity, 0);
                const result = await ProductionOrder.updateOne(
                    { _id: orderId, revision: Number(order.revision || 0) },
                    {
                        $inc: { revision: 1 },
                        $set: { updatedBy: req.userId },
                        $push: {
                            history: {
                                type: 'updated',
                                note: `Xếp ${quantity} SP vào ${orderAllocations.length} phân bổ kế hoạch nháp`,
                                actor: req.userId,
                                at: new Date(),
                            },
                        },
                    },
                    { session }
                );
                if (!result.modifiedCount) {
                    throw new DuplicateError(`Đơn ${order.code} vừa được cập nhật ở thiết bị khác`);
                }
            }
            applied = {
                plantId: preview.context.plantId,
                planIds,
                orderIds: [...orderRows.keys()],
                quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
                allocationCount: rows.length,
            };
        });
    } catch (error: any) {
        if (
            error?.code === 11000 ||
            error?.name === 'VersionError' ||
            error?.errorLabels?.includes?.('TransientTransactionError')
        ) {
            throw new DuplicateError('Kế hoạch vừa thay đổi, vui lòng tải lại và kiểm tra phương án');
        }
        throw error;
    } finally {
        await session.endSession();
    }
    if (!applied) throw new BadRequestError('Không thể áp dụng phương án kế hoạch');
    for (const planId of applied.planIds) {
        const plan: any = await ProductionPlan.findById(planId);
        if (plan) emitPlanUpdated(plan, 'master-plan-applied');
    }
    applied.orderIds.forEach((orderId) => {
        emitToPlant(applied!.plantId, 'production:order-updated', {
            orderId,
            plantId: applied!.plantId,
            changeType: 'plan-allocated',
            at: new Date().toISOString(),
        });
    });
    return sendSuccess(res, applied, 'Đã đưa phương án vào kế hoạch nháp; cần kiểm tra và ban hành từng ngày');
};

export const lookupProductionPlan = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const productionDate = assertValidDate(req.query.date);
    const plan = await ProductionPlan.findOne({ plantId, productionDate });
    if (!plan) return sendSuccess(res, null, 'Ngày này chưa có kế hoạch');
    return sendSuccess(res, serializeProductionPlan(await populatePlan(plan)), 'Lấy kế hoạch sản xuất thành công');
};

export const createProductionPlan = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const productionDate = assertValidDate(req.body.productionDate);
    const existing = await ProductionPlan.findOne({ plantId, productionDate });
    if (existing) {
        return sendSuccess(res, serializeProductionPlan(await populatePlan(existing)), 'Kế hoạch đã tồn tại');
    }
    const plant = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    const schedule = await resolvedTimeSlots(plantId, productionDate);
    try {
        const plan: any = await ProductionPlan.create({
            plantId,
            plantName: plant.name,
            plantCode: plant.code,
            productionDate,
            timeSlots: schedule.timeSlots,
            scheduleSource: schedule.source,
            scheduleWeekday: schedule.weekday,
            scheduleRevision: schedule.revision,
            createdBy: req.userId,
            updatedBy: req.userId,
            history: [{ type: 'created', revision: 0, actor: req.userId, at: new Date() }],
        });
        emitPlanUpdated(plan, 'created');
        return sendSuccess(res, serializeProductionPlan(await populatePlan(plan)), 'Đã tạo kế hoạch sản xuất', 201);
    } catch (error: any) {
        if (error?.code === 11000) {
            const plan = await ProductionPlan.findOne({ plantId, productionDate });
            if (plan) {
                return sendSuccess(res, serializeProductionPlan(await populatePlan(plan)), 'Kế hoạch đã tồn tại');
            }
        }
        throw error;
    }
};

export const updateProductionPlan = async (req: Request, res: Response) => {
    const plan: any = await loadPlan(req, String(req.params.id));
    assertDraft(plan);
    assertRevision(plan, req.body.revision);
    plan.allocations = (await normalizeAllocations(plan, req.body.allocations)) as any;
    plan.revision += 1;
    plan.lastChangeReason = req.body.changeReason;
    plan.updatedBy = req.userId;
    plan.history.push({
        type: 'updated',
        note: req.body.changeReason,
        revision: plan.revision,
        actor: req.userId,
        at: new Date(),
    });
    await savePlan(plan);
    emitPlanUpdated(plan, 'updated');
    return sendSuccess(res, serializeProductionPlan(await populatePlan(plan)), 'Đã lưu kế hoạch');
};

export const publishProductionPlan = async (req: Request, res: Response) => {
    const planId = String(req.params.id);
    const session = await mongoose.startSession();
    let sync: { dayId: string; synchronizedLines: number; preservedLines: string[] } | undefined;

    try {
        await session.withTransaction(async () => {
            const plan: any = await loadPlan(req, planId, session);
            assertDraft(plan);
            assertRevision(plan, req.body.revision);
            if (!plan.allocations.length) throw new BadRequestError('Kế hoạch chưa có phân bổ nào');
            plan.allocations = (await normalizeAllocations(
                plan,
                plan.allocations.map((allocation: any) => ({
                    id: String(allocation._id),
                    lineId: String(allocation.lineId),
                    itemId: String(allocation.itemId),
                    orderId: allocation.orderId ? String(allocation.orderId) : undefined,
                    orderCode: allocation.orderCode,
                    plannedQuantity: allocation.plannedQuantity,
                    hourlyQuota: allocation.hourlyQuota,
                    startSlotKey: allocation.startSlotKey,
                    endSlotKey: allocation.endSlotKey,
                    priority: allocation.priority,
                    dueDate: allocation.dueDate,
                    note: allocation.note,
                })),
                session
            )) as any;
            sync = await applyPlanToDay(plan, String(req.userId), session);
            const now = new Date();
            plan.status = 'published';
            plan.revision += 1;
            plan.publishedAt = now;
            plan.publishedBy = req.userId;
            plan.lastChangeReason = req.body.note || 'Đã ban hành kế hoạch';
            plan.updatedBy = req.userId;
            plan.history.push({
                type: 'published',
                note: req.body.note,
                revision: plan.revision,
                actor: req.userId,
                at: now,
            });
            await savePlan(plan, session);
        });

        const publishedPlan: any = await ProductionPlan.findById(planId);
        if (!publishedPlan || !sync) throw new NotFoundError('Không thể tải lại kế hoạch vừa ban hành');
        emitToPlant(String(publishedPlan.plantId), 'production:updated', {
            dayId: sync.dayId,
            plantId: String(publishedPlan.plantId),
            productionDate: publishedPlan.productionDate,
            changeType: 'plan-published',
            at: new Date().toISOString(),
        });
        emitPlanUpdated(publishedPlan, 'published');
        try {
            await synchronizeProductionOrderLifecycle({
                plantId: String(publishedPlan.plantId),
                actorId: String(req.userId),
                orderIds: (publishedPlan.allocations || [])
                    .map((allocation: any) => (allocation.orderId ? String(allocation.orderId) : ''))
                    .filter(Boolean),
                orderCodes: (publishedPlan.allocations || [])
                    .map((allocation: any) => String(allocation.orderCode || ''))
                    .filter(Boolean),
            });
        } catch (error) {
            console.error('[Production] Đã ban hành kế hoạch nhưng chưa đồng bộ được trạng thái đơn', error);
        }
        return sendSuccess(
            res,
            { plan: serializeProductionPlan(await populatePlan(publishedPlan)), sync },
            sync.preservedLines.length
                ? `Đã ban hành; giữ nguyên dữ liệu đã nhập tại ${sync.preservedLines.join(', ')}`
                : 'Đã ban hành và đồng bộ kế hoạch vào sổ sản xuất'
        );
    } finally {
        await session.endSession();
    }
};

export const reopenProductionPlan = async (req: Request, res: Response) => {
    const plan: any = await loadPlan(req, String(req.params.id));
    assertRevision(plan, req.body.revision);
    if (plan.status !== 'published') throw new BadRequestError('Kế hoạch đang ở trạng thái nháp');
    const now = new Date();
    plan.status = 'draft';
    plan.revision += 1;
    plan.reopenedAt = now;
    plan.reopenedBy = req.userId;
    plan.lastChangeReason = req.body.reason;
    plan.updatedBy = req.userId;
    plan.history.push({
        type: 'reopened',
        note: req.body.reason,
        revision: plan.revision,
        actor: req.userId,
        at: now,
    });
    await savePlan(plan);
    emitPlanUpdated(plan, 'reopened');
    return sendSuccess(res, serializeProductionPlan(await populatePlan(plan)), 'Đã mở lại kế hoạch để điều chỉnh');
};

export const carryOverProductionPlan = async (req: Request, res: Response) => {
    const plan: any = await loadPlan(req, String(req.params.id));
    assertDraft(plan);
    assertRevision(plan, req.body.revision);
    const sourceFilter: Record<string, any> = {
        plantId: plan.plantId,
        status: 'published',
        productionDate: { $lt: plan.productionDate },
    };
    if (req.body.sourcePlanId) sourceFilter._id = req.body.sourcePlanId;
    const sourcePlan: any = await ProductionPlan.findOne(sourceFilter).sort({ productionDate: -1 });
    if (!sourcePlan) throw new NotFoundError('Không có kế hoạch đã ban hành trước đó');
    const sourceDay: any = await ProductionDay.findOne({
        plantId: plan.plantId,
        productionDate: sourcePlan.productionDate,
        status: 'locked',
    });
    if (!sourceDay) throw new BadRequestError('Cần khóa sổ ngày nguồn trước khi chuyển phần còn thiếu');
    const records: any[] = await ProductionLineRecord.find({ dayId: sourceDay._id }).lean();
    const actualByAllocation = new Map<string, number>();
    records.forEach((record: any) => {
        const allocationByRun = new Map<string, string>(
            (record.runs || [])
                .filter((run: any) => run.planAllocationId)
                .map((run: any) => [String(run._id), String(run.planAllocationId)])
        );
        (record.entries || []).forEach((entry: any) => {
            const allocationId = allocationByRun.get(String(entry.runId));
            if (!allocationId) return;
            actualByAllocation.set(
                allocationId,
                Number(actualByAllocation.get(allocationId) || 0) + Number(entry.quantity || 0)
            );
        });
    });
    const importedSources = new Set(
        plan.allocations
            .filter((allocation: any) => allocation.sourceAllocationId)
            .map((allocation: any) => String(allocation.sourceAllocationId))
    );
    const candidates = sourcePlan.allocations
        .map((allocation: any) => ({
            allocation,
            remaining: Math.max(
                0,
                Number(allocation.plannedQuantity || 0) - Number(actualByAllocation.get(String(allocation._id)) || 0)
            ),
        }))
        .filter(({ allocation, remaining }: any) => remaining > 0 && !importedSources.has(String(allocation._id)));
    if (!candidates.length) throw new BadRequestError('Kế hoạch nguồn không còn sản lượng thiếu để chuyển');

    const existingPayload = plan.allocations.map((allocation: any) => ({
        id: String(allocation._id),
        lineId: String(allocation.lineId),
        itemId: String(allocation.itemId),
        orderId: allocation.orderId ? String(allocation.orderId) : undefined,
        orderCode: allocation.orderCode,
        plannedQuantity: allocation.plannedQuantity,
        hourlyQuota: allocation.hourlyQuota,
        startSlotKey: allocation.startSlotKey,
        endSlotKey: allocation.endSlotKey,
        priority: allocation.priority,
        dueDate: allocation.dueDate,
        note: allocation.note,
    }));
    const targetSlots = [...plan.timeSlots]
        .filter((slot: any) => slot.isActive !== false && slot.kind !== 'overtime')
        .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute));
    const targetSlotIndex = new Map<string, number>(
        targetSlots.map((slot: any, index: number) => [String(slot.key), index])
    );
    const sourceSlots = [...sourcePlan.timeSlots]
        .filter((slot: any) => slot.isActive !== false && slot.kind !== 'overtime')
        .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute));
    const sourceSlotIndex = new Map<string, number>(
        sourceSlots.map((slot: any, index: number) => [String(slot.key), index])
    );
    const occupiedByLine = new Map<string, Set<number>>();
    existingPayload.forEach((allocation: any) => {
        const occupied = occupiedByLine.get(allocation.lineId) || new Set<number>();
        const start = targetSlotIndex.get(allocation.startSlotKey);
        const end = targetSlotIndex.get(allocation.endSlotKey);
        if (start !== undefined && end !== undefined) {
            for (let index = start; index <= end; index += 1) occupied.add(index);
        }
        occupiedByLine.set(allocation.lineId, occupied);
    });
    const scheduledCandidates: Array<any> = [];
    const skippedCandidates: Array<any> = [];
    candidates.forEach((candidate: any) => {
        const lineId = String(candidate.allocation.lineId);
        const sourceStart = sourceSlotIndex.get(String(candidate.allocation.startSlotKey));
        const sourceEnd = sourceSlotIndex.get(String(candidate.allocation.endSlotKey));
        const requestedLength =
            sourceStart === undefined || sourceEnd === undefined ? 1 : Math.max(1, sourceEnd - sourceStart + 1);
        const windowLength = Math.min(requestedLength, targetSlots.length);
        const occupied = occupiedByLine.get(lineId) || new Set<number>();
        const preferredStart = targetSlotIndex.get(String(candidate.allocation.startSlotKey));
        const starts = Array.from({ length: Math.max(0, targetSlots.length - windowLength + 1) }, (_, index) => index);
        if (preferredStart !== undefined && starts.includes(preferredStart)) {
            starts.splice(starts.indexOf(preferredStart), 1);
            starts.unshift(preferredStart);
        }
        const availableStart = starts.find((start) => {
            for (let index = start; index < start + windowLength; index += 1) {
                if (occupied.has(index)) return false;
            }
            return true;
        });
        if (availableStart === undefined) {
            skippedCandidates.push(candidate);
            return;
        }
        for (let index = availableStart; index < availableStart + windowLength; index += 1) occupied.add(index);
        occupiedByLine.set(lineId, occupied);
        scheduledCandidates.push({
            ...candidate,
            startSlotKey: targetSlots[availableStart].key,
            endSlotKey: targetSlots[availableStart + windowLength - 1].key,
        });
    });
    if (!scheduledCandidates.length) {
        throw new BadRequestError('Các chuyền nguồn không còn khung giờ trống để xếp phần thiếu');
    }
    const importedPayload = scheduledCandidates.map(({ allocation, remaining, startSlotKey, endSlotKey }: any) => ({
        lineId: String(allocation.lineId),
        itemId: String(allocation.itemId),
        orderId: allocation.orderId ? String(allocation.orderId) : undefined,
        orderCode: allocation.orderCode,
        plannedQuantity: remaining,
        hourlyQuota: allocation.hourlyQuota,
        startSlotKey,
        endSlotKey,
        priority: ['low', 'normal'].includes(allocation.priority) ? 'high' : allocation.priority,
        dueDate: plan.productionDate,
        note: `Chuyển tiếp ${remaining.toLocaleString('vi-VN')} SP từ ngày ${sourcePlan.productionDate}`,
    }));
    const normalized = await normalizeAllocations(plan, [...existingPayload, ...importedPayload]);
    normalized.slice(existingPayload.length).forEach((allocation: any, index: number) => {
        allocation.sourceType = 'carry_over';
        allocation.sourcePlanId = sourcePlan._id;
        allocation.sourceAllocationId = scheduledCandidates[index].allocation._id;
        allocation.sourceProductionDate = sourcePlan.productionDate;
    });
    plan.allocations = normalized as any;
    plan.revision += 1;
    plan.lastChangeReason = `Chuyển phần thiếu từ ${sourcePlan.productionDate}`;
    plan.updatedBy = req.userId;
    plan.history.push({
        type: 'carry_over',
        note: plan.lastChangeReason,
        revision: plan.revision,
        actor: req.userId,
        at: new Date(),
    });
    await savePlan(plan);
    emitPlanUpdated(plan, 'carry-over');
    return sendSuccess(
        res,
        {
            plan: serializeProductionPlan(await populatePlan(plan)),
            importedCount: scheduledCandidates.length,
            importedQuantity: scheduledCandidates.reduce((sum: number, candidate: any) => sum + candidate.remaining, 0),
            skippedCount: skippedCandidates.length,
            sourceProductionDate: sourcePlan.productionDate,
        },
        skippedCandidates.length
            ? `Đã xếp ${scheduledCandidates.length} phân bổ; ${skippedCandidates.length} phân bổ chưa có khung trống`
            : `Đã chuyển ${scheduledCandidates.length} phân bổ còn thiếu sang kế hoạch này`
    );
};
