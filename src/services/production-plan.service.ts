import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionPlan from '@/models/ProductionPlan';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { DEFAULT_PRODUCTION_TIME_SLOTS } from './production.helpers';
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

const inheritedTimeSlots = async (plantId: string, productionDate: string) => {
    const sameDay = await ProductionDay.findOne({ plantId, productionDate }).select('timeSlots').lean();
    if (sameDay?.timeSlots?.length) return sameDay.timeSlots.map((slot: any) => ({ ...slot }));
    const [previousPlan, previousDay] = await Promise.all([
        ProductionPlan.findOne({ plantId, productionDate: { $lt: productionDate } })
            .sort({ productionDate: -1 })
            .select('timeSlots')
            .lean(),
        ProductionDay.findOne({ plantId, productionDate: { $lt: productionDate } })
            .sort({ productionDate: -1 })
            .select('timeSlots')
            .lean(),
    ]);
    const source = previousPlan?.timeSlots?.length ? previousPlan.timeSlots : previousDay?.timeSlots;
    return source?.length
        ? source.map((slot: any) => ({ ...slot }))
        : DEFAULT_PRODUCTION_TIME_SLOTS.map((slot) => ({ ...slot }));
};

const normalizeAllocations = async (plan: any, inputs: any[], session?: mongoose.ClientSession) => {
    const lineIds = [...new Set(inputs.map((input) => String(input.lineId)))];
    const itemIds = [...new Set(inputs.map((input) => String(input.itemId)))];
    const lineQuery = ProductionLine.find({ _id: { $in: lineIds }, plantId: plan.plantId, isActive: true }).lean();
    const itemQuery = ProductionItem.find({ _id: { $in: itemIds }, plantId: plan.plantId, isActive: true }).lean();
    if (session) {
        lineQuery.session(session);
        itemQuery.session(session);
    }
    const [lines, items] = await Promise.all([lineQuery, itemQuery]);
    const lineById = new Map<string, any>(lines.map((line: any) => [String(line._id), line]));
    const itemById = new Map<string, any>(items.map((item: any) => [String(item._id), item]));
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
            orderCode: input.orderCode || undefined,
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
    const timeSlots = await inheritedTimeSlots(plantId, productionDate);
    try {
        const plan: any = await ProductionPlan.create({
            plantId,
            plantName: plant.name,
            plantCode: plant.code,
            productionDate,
            timeSlots,
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
        .filter((slot: any) => slot.isActive !== false)
        .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute));
    const targetSlotIndex = new Map<string, number>(
        targetSlots.map((slot: any, index: number) => [String(slot.key), index])
    );
    const sourceSlots = [...sourcePlan.timeSlots]
        .filter((slot: any) => slot.isActive !== false)
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
