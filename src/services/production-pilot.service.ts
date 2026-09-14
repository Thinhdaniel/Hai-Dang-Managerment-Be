import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionLine from '@/models/ProductionLine';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionPilotRun from '@/models/ProductionPilotRun';
import ProductionPlan from '@/models/ProductionPlan';
import { vietnamIsoDate } from '@/utils/vietnamDate';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { capacityMinutesForAllocation } from './production-capacity.helpers';
import { loadControlTower } from './production-control-tower.service';
import {
    DEFAULT_PRODUCTION_PILOT_CHECKLIST,
    countPilotWorkingDays,
    evaluatePilotDay,
    isPilotWorkingDate,
    summarizeProductionPilot,
    type PilotThresholds,
} from './production-pilot.helpers';
import { sendSuccess } from './service.helpers';

const ACTIVE_STATUSES = ['draft', 'active', 'paused', 'ready_for_signoff'];
const STATUS_TRANSITIONS: Record<string, string[]> = {
    draft: ['active', 'cancelled'],
    active: ['paused', 'cancelled'],
    paused: ['active', 'cancelled'],
    ready_for_signoff: ['paused', 'cancelled'],
    accepted: [],
    cancelled: [],
};
const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');
const actor = (req: Request) => ({
    userId: req.userId,
    name: String(req.user?.name || req.user?.email || 'Người dùng'),
});
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền vận hành pilot của cơ sở này');
    }
};

const resolvePlant = async (req: Request, input: unknown) => {
    const id = String(input || userPlantId(req) || '');
    if (!mongoose.isValidObjectId(id)) throw new BadRequestError('Cần chọn cơ sở hợp lệ');
    assertPlantAccess(req, id);
    const plant: any = await Plant.findOne({ _id: id, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: String(plant._id), name: plant.name, code: plant.code || '' };
};

const thresholdsOf = (run: any): PilotThresholds => ({
    minimumShadowDays: Number(run.thresholds?.minimumShadowDays || 10),
    quantityVariancePercent: Number(run.thresholds?.quantityVariancePercent ?? 2),
    capacityVariancePoints: Number(run.thresholds?.capacityVariancePoints ?? 3),
    countVariance: Number(run.thresholds?.countVariance ?? 0),
});

const metricsOf = (value: any) =>
    value
        ? {
              actualOutput: Number(value.actualOutput || 0),
              plannedOutput: Number(value.plannedOutput || 0),
              openOrders: Number(value.openOrders || 0),
              capacityUtilizationPercent: Number(value.capacityUtilizationPercent || 0),
              materialBlockedOrders: Number(value.materialBlockedOrders || 0),
              forecastLateOrders: Number(value.forecastLateOrders || 0),
          }
        : undefined;

const summarizeRun = (run: any) => {
    const { evaluatedDays: _evaluatedDays, ...summary } = summarizeProductionPilot({
        days: (run.days || []).map((day: any) => ({
            date: day.date,
            systemSnapshot: metricsOf(day.systemSnapshot),
            reference: metricsOf(day.reference),
            varianceAccepted: Boolean(day.varianceAccepted),
        })),
        checklist: run.checklist || [],
        limitations: run.knownLimitations || [],
        thresholds: thresholdsOf(run),
    });
    return summary;
};

const serializeActor = (value: any) =>
    value?.userId
        ? { userId: String(value.userId?._id || value.userId), name: value.name || value.userId?.name || 'Người dùng' }
        : undefined;

const serializeRun = (input: any, compact = false) => {
    const run = typeof input?.toObject === 'function' ? input.toObject() : input;
    const summary = summarizeRun(run);
    const base = {
        id: String(run._id),
        plantId: String(run.plantId),
        plantName: run.plantName,
        plantCode: run.plantCode,
        code: run.code,
        name: run.name,
        sourceFileName: run.sourceFileName,
        sourceDescription: run.sourceDescription,
        startDate: run.startDate,
        targetEndDate: run.targetEndDate,
        status: run.status,
        thresholds: thresholdsOf(run),
        summary,
        revision: Number(run.revision || 0),
        createdAt: run.createdAt ? new Date(run.createdAt).toISOString() : undefined,
        updatedAt: run.updatedAt ? new Date(run.updatedAt).toISOString() : undefined,
    };
    if (compact) return base;
    return {
        ...base,
        days: (run.days || [])
            .map((day: any) => {
                const evaluation = evaluatePilotDay(
                    {
                        date: day.date,
                        systemSnapshot: metricsOf(day.systemSnapshot),
                        reference: metricsOf(day.reference),
                        varianceAccepted: Boolean(day.varianceAccepted),
                    },
                    thresholdsOf(run)
                );
                return {
                    id: String(day._id),
                    date: day.date,
                    systemSnapshot: day.systemSnapshot
                        ? {
                              ...metricsOf(day.systemSnapshot),
                              criticalOrders: Number(day.systemSnapshot.criticalOrders || 0),
                              statusMismatchOrders: Number(day.systemSnapshot.statusMismatchOrders || 0),
                              planCoveragePercent: Number(day.systemSnapshot.planCoveragePercent || 0),
                              capturedAt: new Date(day.systemSnapshot.capturedAt).toISOString(),
                              capturedBy: serializeActor(day.systemSnapshot.capturedBy),
                          }
                        : undefined,
                    reference: day.reference
                        ? {
                              ...metricsOf(day.reference),
                              sourceSheet: day.reference.sourceSheet,
                              note: day.reference.note,
                              enteredAt: new Date(day.reference.enteredAt).toISOString(),
                              enteredBy: serializeActor(day.reference.enteredBy),
                          }
                        : undefined,
                    varianceAccepted: Boolean(day.varianceAccepted),
                    varianceAcceptanceNote: day.varianceAcceptanceNote,
                    varianceAcceptedAt: day.varianceAcceptedAt
                        ? new Date(day.varianceAcceptedAt).toISOString()
                        : undefined,
                    varianceAcceptedBy: serializeActor(day.varianceAcceptedBy),
                    ...evaluation,
                };
            })
            .sort((left: any, right: any) => left.date.localeCompare(right.date)),
        checklist: (run.checklist || []).map((item: any) => ({
            code: item.code,
            category: item.category,
            title: item.title,
            description: item.description,
            mandatory: Boolean(item.mandatory),
            status: item.status,
            evidence: item.evidence,
            updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : undefined,
            updatedBy: serializeActor(item.updatedBy),
        })),
        knownLimitations: (run.knownLimitations || []).map((item: any) => ({
            id: String(item._id),
            title: item.title,
            impact: item.impact,
            mitigation: item.mitigation,
            owner: item.owner,
            dueDate: item.dueDate,
            severity: item.severity,
            status: item.status,
            createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : undefined,
            createdBy: serializeActor(item.createdBy),
            updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : undefined,
            updatedBy: serializeActor(item.updatedBy),
        })),
        signoff: run.signoff?.signedAt
            ? {
                  signedAt: new Date(run.signoff.signedAt).toISOString(),
                  signedBy: serializeActor(run.signoff.signedBy),
                  note: run.signoff.note,
                  version: run.signoff.version,
              }
            : undefined,
        history: (run.history || [])
            .map((item: any) => ({
                id: String(item._id),
                type: item.type,
                note: item.note,
                actor: serializeActor(item.actor),
                at: new Date(item.at).toISOString(),
            }))
            .sort((left: any, right: any) => right.at.localeCompare(left.at)),
        createdBy: serializeActor(run.createdBy),
        updatedBy: serializeActor(run.updatedBy),
    };
};

const loadRun = async (req: Request, id: string) => {
    const run: any = await ProductionPilotRun.findById(id);
    if (!run) throw new NotFoundError('Không tìm thấy đợt pilot');
    assertPlantAccess(req, String(run.plantId));
    return run;
};

const assertRevision = (run: any, revision: unknown) => {
    if (Number(revision) !== Number(run.revision || 0)) {
        throw new DuplicateError('Đợt pilot vừa được người khác cập nhật. Hãy tải lại trước khi thao tác');
    }
};

const assertEditable = (run: any) => {
    if (['accepted', 'cancelled'].includes(run.status)) {
        throw new BadRequestError('Đợt pilot đã kết thúc và hồ sơ bằng chứng đã được khóa');
    }
};

const assertPilotDate = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError('Ngày đối soát không hợp lệ');
};

const pushHistory = (run: any, req: Request, type: string, note?: string) => {
    run.history.push({ type, note, actor: actor(req), at: new Date() });
    run.updatedBy = actor(req);
    run.revision = Number(run.revision || 0) + 1;
};

const refreshGateStatus = (run: any) => {
    if (!['active', 'ready_for_signoff'].includes(run.status)) return;
    run.status = summarizeRun(run).eligibleForSignoff ? 'ready_for_signoff' : 'active';
};

const nextPilotCode = async (plantId: string, date: string) => {
    const prefix = `PILOT-${date.replaceAll('-', '')}`;
    const count = await ProductionPilotRun.countDocuments({ plantId, code: new RegExp(`^${prefix}-`) });
    return `${prefix}-${String(count + 1).padStart(2, '0')}`;
};

const captureCapacity = async (plantId: string, date: string) => {
    const [plan, activeLineCount]: [any, number] = await Promise.all([
        ProductionPlan.findOne({ plantId, productionDate: date, status: 'published' })
            .select('timeSlots allocations')
            .lean(),
        ProductionLine.countDocuments({ plantId, isActive: true }),
    ]);
    const plannedOutput = (plan?.allocations || []).reduce(
        (sum: number, allocation: any) => sum + Number(allocation.plannedQuantity || 0),
        0
    );
    const regularMinutesPerLine = (plan?.timeSlots || [])
        .filter((slot: any) => slot.isActive && slot.kind === 'regular')
        .reduce((sum: number, slot: any) => sum + Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)), 0);
    const allocatedRegularMinutes = (plan?.allocations || []).reduce((sum: number, allocation: any) => {
        const minutes = capacityMinutesForAllocation(
            plan.timeSlots || [],
            allocation.startSlotKey,
            allocation.endSlotKey
        );
        return sum + minutes.regularMinutes;
    }, 0);
    const availableMinutes = regularMinutesPerLine * activeLineCount;
    return {
        plannedOutput: round(plannedOutput),
        capacityUtilizationPercent: availableMinutes ? round((allocatedRegularMinutes / availableMinutes) * 100) : 0,
    };
};

const captureActualOutput = async (plantId: string, date: string) => {
    const records: any[] = await ProductionLineRecord.find({ plantId, productionDate: date }).select('entries').lean();
    return round(
        records.reduce(
            (total, record) =>
                total +
                (record.entries || []).reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0),
            0
        )
    );
};

export const listProductionPilotRuns = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const runs: any[] = await ProductionPilotRun.find({ plantId: plant.id })
        .sort({ startDate: -1, createdAt: -1 })
        .lean();
    return sendSuccess(res, { plant, items: runs.map((run) => serializeRun(run, true)) }, 'Đã tải danh sách pilot');
};

export const getProductionPilotRun = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    return sendSuccess(res, serializeRun(run), 'Đã tải hồ sơ pilot');
};

export const createProductionPilotRun = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    if (req.body.targetEndDate < req.body.startDate) throw new BadRequestError('Ngày kết thúc phải sau ngày bắt đầu');
    if (countPilotWorkingDays(req.body.startDate, req.body.targetEndDate) < req.body.thresholds.minimumShadowDays) {
        throw new BadRequestError('Khoảng pilot không đủ số ngày shadow run tối thiểu đã thiết lập');
    }
    const existing = await ProductionPilotRun.exists({ plantId: plant.id, status: { $in: ACTIVE_STATUSES } });
    if (existing) throw new DuplicateError('Cơ sở đang có một đợt pilot chưa kết thúc');
    const currentActor = actor(req);
    const code = await nextPilotCode(plant.id, req.body.startDate);
    const run: any = await ProductionPilotRun.create({
        plantId: plant.id,
        plantName: plant.name,
        plantCode: plant.code,
        code,
        name: req.body.name,
        sourceFileName: req.body.sourceFileName,
        sourceDescription: req.body.sourceDescription,
        startDate: req.body.startDate,
        targetEndDate: req.body.targetEndDate,
        thresholds: req.body.thresholds,
        checklist: DEFAULT_PRODUCTION_PILOT_CHECKLIST.map(([itemCode, category, title]) => ({
            code: itemCode,
            category,
            title,
            mandatory: true,
            status: 'pending',
        })),
        history: [{ type: 'created', note: 'Khởi tạo hồ sơ shadow run', actor: currentActor, at: new Date() }],
        createdBy: currentActor,
        updatedBy: currentActor,
    });
    return sendSuccess(res, serializeRun(run), 'Đã tạo đợt pilot', 201);
};

export const updateProductionPilotRunStatus = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    const nextStatus = req.body.status;
    if (!STATUS_TRANSITIONS[run.status]?.includes(nextStatus)) {
        throw new BadRequestError(`Không thể chuyển pilot từ ${run.status} sang ${nextStatus}`);
    }
    if (nextStatus === 'active') {
        const conflict = await ProductionPilotRun.exists({
            _id: { $ne: run._id },
            plantId: run.plantId,
            status: { $in: ['active', 'ready_for_signoff'] },
        });
        if (conflict) throw new DuplicateError('Cơ sở đang có một đợt pilot hoạt động');
    }
    run.status = nextStatus;
    if (nextStatus === 'active') refreshGateStatus(run);
    pushHistory(run, req, 'status_changed', req.body.note || `Chuyển trạng thái sang ${nextStatus}`);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã cập nhật trạng thái pilot');
};

export const captureProductionPilotDay = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    assertEditable(run);
    if (!['active', 'ready_for_signoff'].includes(run.status)) {
        throw new BadRequestError('Chỉ có thể chụp số khi pilot đang hoạt động');
    }
    const date = req.body.date || vietnamIsoDate();
    if (date !== vietnamIsoDate()) {
        throw new BadRequestError('Ảnh chụp vận hành phải thực hiện đúng ngày để giữ bằng chứng as-of đáng tin cậy');
    }
    if (date < run.startDate || date > run.targetEndDate) {
        throw new BadRequestError('Ngày đối soát nằm ngoài phạm vi pilot');
    }
    if (!isPilotWorkingDate(date)) throw new BadRequestError('Chủ Nhật không được tính là ngày shadow run');
    const [tower, capacity, actualOutput] = await Promise.all([
        loadControlTower(req, String(run.plantId), 30),
        captureCapacity(String(run.plantId), date),
        captureActualOutput(String(run.plantId), date),
    ]);
    const snapshot = {
        capturedAt: new Date(),
        capturedBy: actor(req),
        actualOutput,
        plannedOutput: capacity.plannedOutput,
        openOrders: Number(tower.summary.openOrders || 0),
        capacityUtilizationPercent: capacity.capacityUtilizationPercent,
        materialBlockedOrders: Number(tower.summary.materialBlockedOrders || 0),
        forecastLateOrders: Number(tower.summary.forecastLateOrders || 0),
        criticalOrders: Number(tower.summary.criticalOrders || 0),
        statusMismatchOrders: Number(tower.summary.statusMismatchOrders || 0),
        planCoveragePercent: Number(tower.summary.planCoveragePercent || 0),
    };
    const day = run.days.find((item: any) => item.date === date);
    if (day) {
        day.systemSnapshot = snapshot;
        day.varianceAccepted = false;
        day.varianceAcceptanceNote = undefined;
        day.varianceAcceptedAt = undefined;
        day.varianceAcceptedBy = undefined;
    } else {
        run.days.push({ date, systemSnapshot: snapshot });
    }
    refreshGateStatus(run);
    pushHistory(run, req, 'system_snapshot', `Chụp số hệ thống ngày ${date}`);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã chụp số hệ thống cho ngày đối soát');
};

export const saveProductionPilotReference = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    assertEditable(run);
    const date = String(req.params.date);
    assertPilotDate(date);
    if (date > vietnamIsoDate()) throw new BadRequestError('Không thể nhập số đối chứng cho ngày tương lai');
    if (date < run.startDate || date > run.targetEndDate) throw new BadRequestError('Ngày nằm ngoài phạm vi pilot');
    if (!isPilotWorkingDate(date)) throw new BadRequestError('Chủ Nhật không được tính là ngày shadow run');
    let day = run.days.find((item: any) => item.date === date);
    if (!day) {
        run.days.push({ date });
        day = run.days.find((item: any) => item.date === date);
    }
    day.reference = { ...req.body.reference, enteredAt: new Date(), enteredBy: actor(req) };
    day.varianceAccepted = false;
    day.varianceAcceptanceNote = undefined;
    day.varianceAcceptedAt = undefined;
    day.varianceAcceptedBy = undefined;
    refreshGateStatus(run);
    pushHistory(run, req, 'reference_saved', `Lưu số Excel đối chứng ngày ${date}`);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã lưu số đối chứng và tính lại sai lệch');
};

export const acceptProductionPilotVariance = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    assertEditable(run);
    assertPilotDate(String(req.params.date));
    const day = run.days.find((item: any) => item.date === String(req.params.date));
    if (!day?.systemSnapshot || !day?.reference) throw new BadRequestError('Ngày này chưa đủ hai nguồn số liệu');
    const evaluation = evaluatePilotDay(
        { date: day.date, systemSnapshot: metricsOf(day.systemSnapshot), reference: metricsOf(day.reference) },
        thresholdsOf(run)
    );
    if (evaluation.status !== 'variance') throw new BadRequestError('Ngày này không có sai lệch cần chấp nhận');
    day.varianceAccepted = true;
    day.varianceAcceptanceNote = req.body.note;
    day.varianceAcceptedAt = new Date();
    day.varianceAcceptedBy = actor(req);
    refreshGateStatus(run);
    pushHistory(run, req, 'variance_accepted', `Chấp nhận sai lệch ngày ${day.date}: ${req.body.note}`);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã ghi nhận ngoại lệ có giải trình');
};

export const updateProductionPilotChecklist = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    assertEditable(run);
    const item = run.checklist.find((row: any) => row.code === String(req.params.code).toUpperCase());
    if (!item) throw new NotFoundError('Không tìm thấy mục kiểm thử');
    item.status = req.body.status;
    item.evidence = req.body.evidence;
    item.updatedAt = new Date();
    item.updatedBy = actor(req);
    refreshGateStatus(run);
    pushHistory(run, req, 'checklist_updated', `${item.code}: ${item.status}`);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã cập nhật bằng chứng UAT');
};

export const addProductionPilotLimitation = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    assertEditable(run);
    run.knownLimitations.push({ ...req.body.limitation, createdAt: new Date(), createdBy: actor(req) });
    refreshGateStatus(run);
    pushHistory(run, req, 'limitation_added', req.body.limitation.title);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã thêm giới hạn đã biết');
};

export const updateProductionPilotLimitation = async (req: Request, res: Response) => {
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    assertEditable(run);
    const item = run.knownLimitations.id(String(req.params.limitationId));
    if (!item) throw new NotFoundError('Không tìm thấy giới hạn');
    Object.assign(item, req.body.limitation, { updatedAt: new Date(), updatedBy: actor(req) });
    refreshGateStatus(run);
    pushHistory(run, req, 'limitation_updated', `${item.title}: ${item.status}`);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã cập nhật giới hạn');
};

export const signoffProductionPilotRun = async (req: Request, res: Response) => {
    if (![USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) {
        throw new UnAuthorizedError('Chỉ Giám đốc hoặc Super Admin được ký nghiệm thu UAT');
    }
    const run = await loadRun(req, String(req.params.id));
    assertRevision(run, req.body.revision);
    if (run.status !== 'ready_for_signoff') {
        throw new BadRequestError('Pilot phải ở trạng thái sẵn sàng nghiệm thu trước khi ký');
    }
    const summary = summarizeRun(run);
    if (!summary.eligibleForSignoff) {
        throw new BadRequestError('Chưa đủ điều kiện ký: cần đủ ngày đối soát, checklist và xử lý rủi ro chặn');
    }
    run.status = 'accepted';
    run.signoff = {
        signedAt: new Date(),
        signedBy: actor(req),
        note: req.body.note,
        version: Number(run.signoff?.version || 0) + 1,
    };
    pushHistory(run, req, 'signed_off', req.body.note);
    await run.save();
    return sendSuccess(res, serializeRun(run), 'Đã ký nghiệm thu pilot');
};
