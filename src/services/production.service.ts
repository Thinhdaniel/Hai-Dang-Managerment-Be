import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionOperation from '@/models/ProductionOperation';
import ProductionPlan from '@/models/ProductionPlan';
import ProductionQcRecord from '@/models/ProductionQcRecord';
import { buildPaginatedResponse } from '@/utils/pagination';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { sendSuccess } from './service.helpers';
import {
    buildProductionDayDetail,
    buildTimeSlotLabel,
    decideProductionEntrySync,
    DEFAULT_PRODUCTION_TIME_SLOTS,
    findProductionRunStartConflicts,
    redactProductionFinancials,
    serializeProductionItem,
    serializeProductionLine,
    serializeProductionOperation,
    validateProductionDayForSubmission,
} from './production.helpers';
import { buildProductionWorkbook } from './production-export.service';
import { buildProductionBoard } from './production-board.helpers';
import { buildProductionForecast } from './production-forecast.helpers';
import { buildProductionMonitor } from './production-monitor.helpers';
import { serializeProductionPlan } from './production-plan.service';
import { shouldProcessProductionPriceUpdate, summarizeProductionPriceCorrection } from './production-price.helpers';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCTION_STATUSES = new Set(['draft', 'submitted', 'locked']);
const ACTOR_SELECT = 'fullname username email';
const DAY_ACTOR_PATHS = [
    { path: 'createdBy', select: ACTOR_SELECT },
    { path: 'updatedBy', select: ACTOR_SELECT },
    { path: 'submittedBy', select: ACTOR_SELECT },
    { path: 'lockedBy', select: ACTOR_SELECT },
    { path: 'reopenedBy', select: ACTOR_SELECT },
    { path: 'statusHistory.actor', select: ACTOR_SELECT },
];
const RECORD_ACTOR_PATHS = [
    { path: 'workerCountConfirmedBy', select: ACTOR_SELECT },
    { path: 'updatedBy', select: ACTOR_SELECT },
    { path: 'runs.createdBy', select: ACTOR_SELECT },
    { path: 'entries.enteredBy', select: ACTOR_SELECT },
    { path: 'entries.updatedBy', select: ACTOR_SELECT },
    { path: 'qcEntries.enteredBy', select: ACTOR_SELECT },
    { path: 'qcEntries.updatedBy', select: ACTOR_SELECT },
    { path: 'operationTracks.createdBy', select: ACTOR_SELECT },
    { path: 'operationEntries.enteredBy', select: ACTOR_SELECT },
    { path: 'operationEntries.updatedBy', select: ACTOR_SELECT },
];
const QC_RECORD_ACTOR_PATHS = [
    { path: 'enteredBy', select: ACTOR_SELECT },
    { path: 'updatedBy', select: ACTOR_SELECT },
];

const getVietnamClock = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    })
        .formatToParts(now)
        .reduce<Record<string, string>>((result, part) => {
            if (part.type !== 'literal') result[part.type] = part.value;
            return result;
        }, {});
    return {
        localDate: `${parts.year}-${parts.month}-${parts.day}`,
        minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
        asOf: now.toISOString(),
    };
};

const userPlantId = (req: Request): string => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền thao tác dữ liệu sản lượng của cơ sở này');
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

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeTimeSlots = (input: any[]) => {
    const slots = input
        .map((slot) => {
            const startMinute = Number(slot.startMinute);
            const endMinute = Number(slot.endMinute);
            return {
                key: String(slot.key),
                // Nhãn luôn do server sinh từ mốc phút — client gửi gì cũng bỏ qua,
                // nhờ vậy nhãn không bao giờ lệch với giờ thực.
                label: buildTimeSlotLabel(startMinute, endMinute),
                startMinute,
                endMinute,
                kind: slot.kind || 'regular',
                isActive: slot.isActive !== false,
            };
        })
        .sort((left, right) => left.startMinute - right.startMinute);

    const activeSlots = slots.filter((slot) => slot.isActive);
    for (let index = 1; index < activeSlots.length; index += 1) {
        if (activeSlots[index].startMinute < activeSlots[index - 1].endMinute) {
            throw new BadRequestError(
                `Khung giờ ${activeSlots[index].label} bị chồng lên ${activeSlots[index - 1].label}`
            );
        }
    }
    return slots;
};

const assertPlantExists = async (plantId: string) => {
    const plant = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return plant;
};

const assertDayEditable = (day: any) => {
    if (day.status === 'submitted') {
        throw new BadRequestError('Ngày sản xuất đang chờ duyệt; cần mở lại trước khi chỉnh sửa');
    }
    if (day.status === 'locked') throw new BadRequestError('Ngày sản xuất đã khóa sổ');
};

// Danh sách chuyền chạy trong ngày là CHỐT THEO NGÀY: seed một lần lúc khởi tạo rồi thôi.
// Trước đây hàm này chạy ở mọi lần đọc ngày nháp nên thêm chuyền mới là nó nhồi ngược
// vào tất cả các ngày cũ (card trắng) và tắt chuyền cũng không gỡ được ra.
// Muốn đổi biên chế chuyền của một ngày cụ thể thì dùng addProductionDayLine/removeProductionDayLine.
const ensureDayLineRecords = async (day: any) => {
    if (day.status && day.status !== 'draft') return;
    if (day.lineRosterSeededAt) return;
    // Ngày cũ (tạo trước khi có cột mốc) đã có sẵn bản ghi -> coi như đã xếp xong.
    const existing = await ProductionLineRecord.countDocuments({ dayId: day._id });
    if (existing > 0) {
        await ProductionDay.updateOne({ _id: day._id }, { $set: { lineRosterSeededAt: new Date() } });
        day.lineRosterSeededAt = new Date();
        return;
    }
    const lines = await ProductionLine.find({ plantId: day.plantId, isActive: true })
        .sort({ sortOrder: 1, code: 1 })
        .lean();
    if (!lines.length) return;

    const operations = lines.map((line: any) => ({
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
    }));
    // Mongoose suy luận mảng subdocument thành DocumentArray ở bulkWrite dù payload chỉ dùng $setOnInsert.
    await ProductionLineRecord.bulkWrite(operations as any, { ordered: false });
    await ProductionDay.updateOne({ _id: day._id }, { $set: { lineRosterSeededAt: new Date() } });
    day.lineRosterSeededAt = new Date();
};

export const loadDayDetail = async (dayInput: any, role?: string) => {
    const day = typeof dayInput?.toObject === 'function' ? dayInput : await ProductionDay.findById(dayInput);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    await ensureDayLineRecords(day);
    await day.populate(DAY_ACTOR_PATHS);
    const [records, qcRecords] = await Promise.all([
        ProductionLineRecord.find({ dayId: day._id }).sort({ sortOrder: 1, lineCode: 1 }).populate(RECORD_ACTOR_PATHS),
        ProductionQcRecord.find({ dayId: day._id }).sort({ lineCode: 1, slotKey: 1 }).populate(QC_RECORD_ACTOR_PATHS),
    ]);
    const detail = buildProductionDayDetail(day, records, qcRecords);
    return role && ![USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER].includes(role as USER_ROLE)
        ? redactProductionFinancials(detail)
        : { ...detail, financialsVisible: true };
};

const loadDayForWrite = async (req: Request, dayId: string) => {
    const day = await ProductionDay.findById(dayId);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    assertPlantAccess(req, String(day.plantId));
    assertDayEditable(day);
    return day;
};

export const loadDayForQcWrite = async (req: Request, dayId: string) => {
    const day = await ProductionDay.findById(dayId);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    assertPlantAccess(req, String(day.plantId));
    // QC có thể hoàn thiện số kiểm sau khi tổ trưởng đã gửi ngày. Chỉ khóa khi
    // quản lý đã chốt sổ chính thức.
    if (day.status === 'locked') throw new BadRequestError('Ngày sản xuất đã khóa sổ');
    return day;
};

export const emitProductionChange = (day: any, payload: Record<string, unknown>) => {
    emitToPlant(String(day.plantId), 'production:updated', {
        dayId: String(day._id),
        plantId: String(day.plantId),
        productionDate: day.productionDate,
        at: new Date().toISOString(),
        ...payload,
    });
};

const saveRecord = async (record: any) => {
    try {
        return await record.save();
    } catch (error: any) {
        if (error?.name === 'VersionError') {
            throw new DuplicateError('Dữ liệu vừa được cập nhật từ thiết bị khác, vui lòng thử lại');
        }
        throw error;
    }
};

const resolveOperationConfigs = async (plantId: any, configs: any[]) => {
    const ids = configs.map((config) => String(config.operationId));
    if (!ids.length) return [];
    const operations: any[] = await ProductionOperation.find({
        _id: { $in: ids },
        plantId,
        isActive: true,
    });
    const operationById = new Map(operations.map((operation) => [String(operation._id), operation]));
    const missing = ids.find((id) => !operationById.has(id));
    if (missing) throw new BadRequestError('Có công đoạn không tồn tại hoặc đã ngừng sử dụng');
    return configs
        .map((config) => {
            const operation = operationById.get(String(config.operationId));
            return {
                operationId: operation._id,
                operationCode: operation.code,
                operationName: operation.name,
                unit: operation.unit || 'SP',
                hourlyQuota: Number(config.hourlyQuota || 0),
                required: config.required !== false,
                sortOrder: Number(config.sortOrder || 0),
            };
        })
        .sort(
            (left, right) => left.sortOrder - right.sortOrder || left.operationCode.localeCompare(right.operationCode)
        );
};

const replaceOperationTracksForRun = (
    record: any,
    run: any,
    operationConfigs: any[],
    actorId: unknown,
    enabled: boolean
) => {
    const existingTracks = record.operationTracks.filter((track: any) => String(track.sourceRunId) === String(run._id));
    const trackIds = new Set(existingTracks.map((track: any) => String(track._id)));
    const hasEntries = record.operationEntries.some((entry: any) => trackIds.has(String(entry.trackId)));
    if (hasEntries) {
        throw new BadRequestError('Công đoạn của mã hàng đã có số liệu; không thể thay đổi cấu hình theo dõi');
    }
    [...existingTracks].forEach((track: any) => track.deleteOne());
    if (!enabled) return;
    operationConfigs.forEach((config) => {
        record.operationTracks.push({
            ...config,
            itemId: run.itemId,
            itemCode: run.itemCode,
            sourceRunId: run._id,
            startedSlotKey: run.startedSlotKey,
            endedSlotKey: run.endedSlotKey,
            status: run.status === 'closed' ? 'closed' : 'active',
            createdBy: actorId,
            createdAt: new Date(),
        });
    });
};

const closeOperationTracksForRun = (record: any, runId: unknown, endedSlotKey: string) => {
    record.operationTracks
        .filter((track: any) => String(track.sourceRunId) === String(runId) && track.status === 'active')
        .forEach((track: any) => {
            track.status = 'closed';
            track.endedSlotKey = endedSlotKey;
        });
};

const buildDetailsForDays = async (days: any[], role?: string) => {
    if (!days.length) return [];
    await Promise.all(days.map((day) => day.populate(DAY_ACTOR_PATHS)));
    const dayIds = days.map((day) => day._id);
    const records = await ProductionLineRecord.find({ dayId: { $in: dayIds } })
        .sort({ sortOrder: 1, lineCode: 1 })
        .populate(RECORD_ACTOR_PATHS);
    const recordsByDay = new Map<string, any[]>();
    records.forEach((record: any) => {
        const key = String(record.dayId);
        const current = recordsByDay.get(key) || [];
        current.push(record);
        recordsByDay.set(key, current);
    });

    return days.map((day) => {
        const detail = buildProductionDayDetail(day, recordsByDay.get(String(day._id)) || []);
        return role && ![USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER].includes(role as USER_ROLE)
            ? redactProductionFinancials(detail)
            : { ...detail, financialsVisible: true };
    });
};

const transitionProductionDay = async (
    req: Request,
    nextStatus: 'draft' | 'submitted' | 'locked',
    successMessage: string
) => {
    const day: any = await ProductionDay.findById(req.params.id);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    assertPlantAccess(req, String(day.plantId));
    const currentStatus = String(day.status || 'draft') as 'draft' | 'submitted' | 'locked';
    const note = String(req.body?.note || '').trim();

    if (nextStatus === 'submitted') {
        if (currentStatus !== 'draft') throw new BadRequestError('Chỉ ngày đang ở trạng thái nháp mới được gửi duyệt');
        const detail = await loadDayDetail(day);
        const validation = validateProductionDayForSubmission(detail);
        if (!validation.valid) throw new BadRequestError(validation.message || 'Ngày sản xuất chưa đủ dữ liệu');
    } else if (nextStatus === 'locked') {
        if (currentStatus !== 'submitted') {
            throw new BadRequestError('Chỉ ngày đang chờ duyệt mới được khóa sổ');
        }
    } else {
        if (!['submitted', 'locked'].includes(currentStatus)) {
            throw new BadRequestError('Ngày sản xuất đang ở trạng thái nháp');
        }
        if (!note) throw new BadRequestError('Cần nhập lý do mở lại ngày sản xuất');
        if (currentStatus === 'locked' && ![USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) {
            throw new UnAuthorizedError('Chỉ Giám đốc hoặc Super Admin được mở lại ngày đã khóa sổ');
        }
    }

    const now = new Date();
    const statusFields: Record<string, unknown> = {
        status: nextStatus,
        statusNote: note || undefined,
        updatedBy: req.userId,
    };
    if (nextStatus === 'submitted') {
        statusFields.submittedAt = now;
        statusFields.submittedBy = req.userId;
    } else if (nextStatus === 'locked') {
        statusFields.lockedAt = now;
        statusFields.lockedBy = req.userId;
    } else {
        statusFields.reopenedAt = now;
        statusFields.reopenedBy = req.userId;
    }

    const updated = await ProductionDay.findOneAndUpdate(
        { _id: day._id, status: currentStatus },
        {
            $set: statusFields,
            $push: {
                statusHistory: {
                    from: currentStatus,
                    to: nextStatus,
                    note: note || undefined,
                    actor: req.userId,
                    at: now,
                },
            },
        },
        { new: true, runValidators: true }
    );
    if (!updated) throw new DuplicateError('Trạng thái vừa thay đổi trên thiết bị khác, vui lòng tải lại');
    emitProductionChange(updated, { changeType: 'day-status-updated', status: nextStatus });
    return { detail: await loadDayDetail(updated, req.role), message: successMessage };
};

export const listProductionLines = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const filter: Record<string, unknown> = { plantId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (req.query.search) {
        const search = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
        filter.$or = [{ code: search }, { name: search }, { leaderName: search }];
    }
    const items = await ProductionLine.find(filter).sort({ sortOrder: 1, code: 1 });
    return sendSuccess(res, items.map(serializeProductionLine), 'Lấy danh mục chuyền thành công');
};

export const createProductionLine = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    await assertPlantExists(plantId);
    try {
        const item = await ProductionLine.create({
            ...req.body,
            plantId,
            code: String(req.body.code).trim().toUpperCase(),
            createdBy: req.userId,
            updatedBy: req.userId,
        });
        return sendSuccess(res, serializeProductionLine(item), 'Đã thêm chuyền', StatusCodes.CREATED);
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã chuyền đã tồn tại trong cơ sở');
        throw error;
    }
};

export const updateProductionLine = async (req: Request, res: Response) => {
    const item = await ProductionLine.findById(req.params.id);
    if (!item) throw new NotFoundError('Không tìm thấy chuyền');
    assertPlantAccess(req, String(item.plantId));
    Object.assign(item, req.body, {
        ...(req.body.code ? { code: String(req.body.code).trim().toUpperCase() } : {}),
        updatedBy: req.userId,
    });
    try {
        await item.save();
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã chuyền đã tồn tại trong cơ sở');
        throw error;
    }
    return sendSuccess(res, serializeProductionLine(item), 'Đã cập nhật chuyền');
};

export const listProductionOperations = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const filter: Record<string, unknown> = { plantId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (req.query.search) {
        const search = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
        filter.$or = [{ code: search }, { name: search }];
    }
    const operations = await ProductionOperation.find(filter).sort({ sortOrder: 1, code: 1 });
    return sendSuccess(res, operations.map(serializeProductionOperation), 'Lấy danh mục công đoạn thành công');
};

export const createProductionOperation = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    await assertPlantExists(plantId);
    try {
        const operation = await ProductionOperation.create({
            ...req.body,
            plantId,
            code: String(req.body.code).trim().toUpperCase(),
            createdBy: req.userId,
            updatedBy: req.userId,
        });
        return sendSuccess(res, serializeProductionOperation(operation), 'Đã thêm công đoạn', StatusCodes.CREATED);
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã công đoạn đã tồn tại trong cơ sở');
        throw error;
    }
};

export const updateProductionOperation = async (req: Request, res: Response) => {
    const operation = await ProductionOperation.findById(req.params.id);
    if (!operation) throw new NotFoundError('Không tìm thấy công đoạn');
    assertPlantAccess(req, String(operation.plantId));
    Object.assign(operation, req.body, {
        ...(req.body.code ? { code: String(req.body.code).trim().toUpperCase() } : {}),
        updatedBy: req.userId,
    });
    try {
        await operation.save();
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã công đoạn đã tồn tại trong cơ sở');
        throw error;
    }
    return sendSuccess(res, serializeProductionOperation(operation), 'Đã cập nhật công đoạn');
};

export const listProductionItems = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const filter: Record<string, unknown> = { plantId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (req.query.search) {
        const search = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
        filter.$or = [{ code: search }, { name: search }];
    }
    const items = await ProductionItem.find(filter).sort({ code: 1 });
    return sendSuccess(res, items.map(serializeProductionItem), 'Lấy danh mục mã hàng thành công');
};

export const listProductionDays = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 31, 1), 62);
    const skip = (page - 1) * limit;
    const from = req.query.from ? assertValidDate(req.query.from) : undefined;
    const to = req.query.to ? assertValidDate(req.query.to) : undefined;
    if (from && to && from > to) throw new BadRequestError('Khoảng ngày không hợp lệ');

    const filter: Record<string, any> = { plantId };
    if (from || to) {
        filter.productionDate = {};
        if (from) filter.productionDate.$gte = from;
        if (to) filter.productionDate.$lte = to;
    }
    if (req.query.status) {
        const status = String(req.query.status);
        if (!PRODUCTION_STATUSES.has(status)) throw new BadRequestError('Trạng thái ngày sản xuất không hợp lệ');
        filter.status = status;
    }

    const [days, total] = await Promise.all([
        ProductionDay.find(filter).sort({ productionDate: -1, createdAt: -1 }).skip(skip).limit(limit),
        ProductionDay.countDocuments(filter),
    ]);
    const details = await buildDetailsForDays(days, req.role);
    return sendSuccess(res, buildPaginatedResponse(details, total, page, limit), 'Lấy lịch sử sản xuất thành công');
};

export const getProductionMonitor = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const productionDate = assertValidDate(req.query.date);
    const day = await ProductionDay.findOne({ plantId, productionDate });
    if (!day) return sendSuccess(res, null, 'Ngày sản xuất chưa được khởi tạo');

    const [detail, baselineDays, plan] = await Promise.all([
        loadDayDetail(day),
        ProductionDay.find({
            plantId,
            productionDate: { $lt: productionDate },
            status: 'locked',
        })
            .sort({ productionDate: -1 })
            .limit(7),
        ProductionPlan.findOne({ plantId, productionDate, status: 'published' }),
    ]);
    const baselineDetails = await buildDetailsForDays(baselineDays);
    const clock = getVietnamClock();
    const monitor = buildProductionMonitor(detail, baselineDetails, clock);
    const serializedPlan = plan ? serializeProductionPlan(plan) : undefined;
    const forecast = serializedPlan ? buildProductionForecast(serializedPlan, detail, clock) : undefined;
    if (forecast) {
        monitor.alerts = [...monitor.alerts, ...forecast.alerts].sort((left: any, right: any) => {
            const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
            return (
                Number(rank[left.severity] ?? 9) - Number(rank[right.severity] ?? 9) ||
                String(left.lineCode).localeCompare(String(right.lineCode))
            );
        });
        monitor.summary.criticalAlerts = monitor.alerts.filter((alert: any) => alert.severity === 'critical').length;
        monitor.summary.warningAlerts = monitor.alerts.filter((alert: any) => alert.severity === 'warning').length;
    }
    return sendSuccess(
        res,
        { day: detail, monitor: { ...monitor, forecast }, plan: serializedPlan },
        baselineDetails.length
            ? `Đã đối chiếu với ${baselineDetails.length} ngày khóa sổ gần nhất`
            : 'Chưa có ngày khóa sổ trước đó để làm đường chuẩn'
    );
};

export const getProductionBoard = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const productionDate = assertValidDate(req.query.date);
    const day = await ProductionDay.findOne({ plantId, productionDate });
    if (!day) return sendSuccess(res, null, 'Ngày sản xuất chưa được khởi tạo');

    // Endpoint bảng chuyền chỉ trả số liệu tổng hợp, không lộ người nhập hoặc lịch sử thao tác.
    const detail = await loadDayDetail(day);
    return sendSuccess(res, buildProductionBoard(detail, getVietnamClock()), 'Lấy bảng nhịp chuyền thành công');
};

export const createProductionItem = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    await assertPlantExists(plantId);
    const now = new Date();
    try {
        const item = await ProductionItem.create({
            ...req.body,
            plantId,
            code: String(req.body.code).trim().toUpperCase(),
            priceHistory: [{ unitPrice: req.body.unitPrice ?? 0, effectiveFrom: now, updatedBy: req.userId }],
            createdBy: req.userId,
            updatedBy: req.userId,
        });
        return sendSuccess(res, serializeProductionItem(item), 'Đã thêm mã hàng', StatusCodes.CREATED);
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã hàng đã tồn tại trong cơ sở');
        throw error;
    }
};

export const updateProductionItem = async (req: Request, res: Response) => {
    const session = await mongoose.startSession();
    let savedItem: any;
    let affectedDayIds: unknown[] = [];
    let priceUpdate: any;
    try {
        await session.withTransaction(async () => {
            const item: any = await ProductionItem.findById(req.params.id).session(session);
            if (!item) throw new NotFoundError('Không tìm thấy mã hàng');
            assertPlantAccess(req, String(item.plantId));

            const previousUnitPrice = Number(item.unitPrice || 0);
            const nextUnitPrice =
                req.body.unitPrice === undefined ? previousUnitPrice : Number(req.body.unitPrice || 0);
            const priceChanged = nextUnitPrice !== previousUnitPrice;
            const unitPriceMode = req.body.unitPriceMode || 'future_only';
            const unitPriceChangeReason = String(req.body.unitPriceChangeReason || '').trim();
            const priceUpdateRequested = shouldProcessProductionPriceUpdate({
                priceChanged,
                unitPriceMode,
                unitPriceEffectiveFrom: req.body.unitPriceEffectiveFrom,
            });
            const now = new Date();

            if (priceUpdateRequested) {
                if (unitPriceChangeReason.length < 3) {
                    throw new BadRequestError('Cần ghi rõ lý do thay đổi đơn giá để truy vết');
                }

                let impact = summarizeProductionPriceCorrection({
                    records: [],
                    plans: [],
                    itemId: item._id,
                    nextUnitPrice,
                });
                let unitPriceEffectiveFrom: string | undefined;

                if (unitPriceMode === 'recalculate_from_date') {
                    unitPriceEffectiveFrom = String(req.body.unitPriceEffectiveFrom || '');
                    if (!DATE_PATTERN.test(unitPriceEffectiveFrom)) {
                        throw new BadRequestError('Cần chọn ngày bắt đầu tính lại đơn giá');
                    }
                    if (unitPriceEffectiveFrom > getVietnamClock().localDate) {
                        throw new BadRequestError('Ngày tính lại đơn giá không được nằm trong tương lai');
                    }

                    // MongoDB does not support parallel operations on the same transaction session.
                    const records = await ProductionLineRecord.find({
                        plantId: item.plantId,
                        productionDate: { $gte: unitPriceEffectiveFrom },
                        'runs.itemId': item._id,
                    })
                        .select('_id dayId productionDate runs entries')
                        .session(session)
                        .lean();
                    const plans = await ProductionPlan.find({
                        plantId: item.plantId,
                        productionDate: { $gte: unitPriceEffectiveFrom },
                        'allocations.itemId': item._id,
                    })
                        .select('_id allocations')
                        .session(session)
                        .lean();
                    impact = summarizeProductionPriceCorrection({
                        records,
                        plans,
                        itemId: item._id,
                        nextUnitPrice,
                    });

                    if (impact.recordIds.length) {
                        await ProductionLineRecord.updateMany(
                            { _id: { $in: impact.recordIds } },
                            {
                                $set: {
                                    'runs.$[run].unitPriceSnapshot': nextUnitPrice,
                                    updatedBy: req.userId,
                                    updatedAt: now,
                                },
                            },
                            {
                                arrayFilters: [
                                    {
                                        'run.itemId': item._id,
                                        'run.unitPriceSnapshot': { $ne: nextUnitPrice },
                                    },
                                ],
                                session,
                                runValidators: true,
                            }
                        );
                    }
                    if (impact.planIds.length) {
                        await ProductionPlan.updateMany(
                            { _id: { $in: impact.planIds } },
                            {
                                $set: {
                                    'allocations.$[allocation].unitPriceSnapshot': nextUnitPrice,
                                    updatedBy: req.userId,
                                    updatedAt: now,
                                },
                            },
                            {
                                arrayFilters: [
                                    {
                                        'allocation.itemId': item._id,
                                        'allocation.unitPriceSnapshot': { $ne: nextUnitPrice },
                                    },
                                ],
                                session,
                                runValidators: true,
                            }
                        );
                    }
                }

                const currentPrice = [...(item.priceHistory || [])].reverse().find((entry: any) => !entry.effectiveTo);
                if (currentPrice) currentPrice.effectiveTo = now;
                item.priceHistory.push({
                    unitPrice: nextUnitPrice,
                    effectiveFrom: now,
                    updatedBy: req.userId,
                    changeType: unitPriceMode,
                    effectiveProductionDate: unitPriceEffectiveFrom,
                    reason: unitPriceChangeReason,
                    affectedDayCount: impact.affectedDayCount,
                    affectedRunCount: impact.affectedRunCount,
                    affectedEntryCount: impact.affectedEntryCount,
                    affectedPlanAllocationCount: impact.affectedPlanAllocationCount,
                });
                affectedDayIds = impact.dayIds;
                priceUpdate = {
                    mode: unitPriceMode,
                    previousUnitPrice,
                    nextUnitPrice,
                    effectiveFrom: unitPriceEffectiveFrom,
                    affectedDayCount: impact.affectedDayCount,
                    affectedRecordCount: impact.affectedRecordCount,
                    affectedRunCount: impact.affectedRunCount,
                    affectedEntryCount: impact.affectedEntryCount,
                    affectedPlanCount: impact.affectedPlanCount,
                    affectedPlanAllocationCount: impact.affectedPlanAllocationCount,
                };
            }

            const {
                unitPriceMode: _unitPriceMode,
                unitPriceEffectiveFrom: _unitPriceEffectiveFrom,
                unitPriceChangeReason: _unitPriceChangeReason,
                ...catalogPatch
            } = req.body;
            Object.assign(item, catalogPatch, {
                ...(req.body.code ? { code: String(req.body.code).trim().toUpperCase() } : {}),
                updatedBy: req.userId,
            });
            savedItem = await item.save({ session });
        });
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã hàng đã tồn tại trong cơ sở');
        throw error;
    } finally {
        await session.endSession();
    }

    if (priceUpdate?.mode === 'recalculate_from_date' && affectedDayIds.length) {
        const affectedDays = await ProductionDay.find({ _id: { $in: affectedDayIds } }).lean();
        affectedDays.forEach((day) =>
            emitProductionChange(day, {
                changeType: 'unit-price-corrected',
                itemId: String(savedItem._id),
                itemCode: savedItem.code,
                effectiveFrom: priceUpdate.effectiveFrom,
            })
        );
    }

    const data = {
        ...serializeProductionItem(savedItem),
        ...(priceUpdate ? { priceUpdate } : {}),
    };
    const message =
        priceUpdate?.mode === 'recalculate_from_date'
            ? `Đã cập nhật mã hàng và tính lại ${priceUpdate.affectedEntryCount} khung nhập trên ${priceUpdate.affectedDayCount} ngày`
            : priceUpdate
              ? 'Đã cập nhật mã hàng; đơn giá mới chỉ áp dụng cho lần chạy tạo sau'
              : 'Đã cập nhật mã hàng';
    return sendSuccess(res, data, message);
};

export const updateProductionItemOperations = async (req: Request, res: Response) => {
    const item: any = await ProductionItem.findById(req.params.id);
    if (!item) throw new NotFoundError('Không tìm thấy mã hàng');
    assertPlantAccess(req, String(item.plantId));
    item.operationTemplates = await resolveOperationConfigs(item.plantId, req.body.operations);
    item.updatedBy = req.userId;
    await item.save();
    return sendSuccess(res, serializeProductionItem(item), 'Đã cập nhật template công đoạn');
};

export const lookupProductionDay = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const productionDate = assertValidDate(req.query.date);
    const day = await ProductionDay.findOne({ plantId, productionDate });
    if (!day) return sendSuccess(res, null, 'Ngày sản xuất chưa được khởi tạo');
    return sendSuccess(res, await loadDayDetail(day, req.role), 'Lấy ngày sản xuất thành công');
};

export const getProductionDay = async (req: Request, res: Response) => {
    const day = await ProductionDay.findById(req.params.id);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    assertPlantAccess(req, String(day.plantId));
    return sendSuccess(res, await loadDayDetail(day, req.role), 'Lấy ngày sản xuất thành công');
};

export const submitProductionDay = async (req: Request, res: Response) => {
    const result = await transitionProductionDay(req, 'submitted', 'Đã gửi ngày sản xuất để quản lý duyệt');
    return sendSuccess(res, result.detail, result.message);
};

export const lockProductionDay = async (req: Request, res: Response) => {
    const result = await transitionProductionDay(req, 'locked', 'Đã khóa sổ ngày sản xuất');
    return sendSuccess(res, result.detail, result.message);
};

export const reopenProductionDay = async (req: Request, res: Response) => {
    const result = await transitionProductionDay(req, 'draft', 'Đã mở lại ngày sản xuất để chỉnh sửa');
    return sendSuccess(res, result.detail, result.message);
};

export const exportProductionDay = async (req: Request, res: Response) => {
    const day: any = await ProductionDay.findById(req.params.id);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    assertPlantAccess(req, String(day.plantId));
    const detail = await loadDayDetail(day);
    const workbook = await buildProductionWorkbook({ detail });
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `bao-cao-san-luong-${day.productionDate}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};

export const createProductionDay = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const productionDate = assertValidDate(req.body.productionDate);
    if (req.role === USER_ROLE.LINE_LEADER && req.body.timeSlots) {
        throw new UnAuthorizedError('Tổ trưởng không được tự thay đổi khung giờ khi khởi tạo ngày sản xuất');
    }
    const existing = await ProductionDay.findOne({ plantId, productionDate });
    if (existing) {
        return sendSuccess(res, await loadDayDetail(existing, req.role), 'Ngày sản xuất đã tồn tại');
    }

    const plant = await assertPlantExists(plantId);
    const previousDay = req.body.timeSlots
        ? null
        : await ProductionDay.findOne({ plantId, productionDate: { $lt: productionDate } })
              .sort({ productionDate: -1 })
              .select('timeSlots')
              .lean();
    const inheritedSlots = previousDay?.timeSlots?.length
        ? previousDay.timeSlots.map((slot: any) => ({ ...slot }))
        : DEFAULT_PRODUCTION_TIME_SLOTS.map((slot) => ({ ...slot }));
    const timeSlots = normalizeTimeSlots(req.body.timeSlots || inheritedSlots);
    try {
        const day = await ProductionDay.create({
            plantId,
            plantName: plant.name,
            plantCode: plant.code,
            productionDate,
            timeSlots,
            createdBy: req.userId,
            updatedBy: req.userId,
        });
        await ensureDayLineRecords(day);
        emitProductionChange(day, { changeType: 'day-created' });
        return sendSuccess(res, await loadDayDetail(day, req.role), 'Đã khởi tạo ngày sản xuất', StatusCodes.CREATED);
    } catch (error: any) {
        if (error?.code === 11000) {
            const day = await ProductionDay.findOne({ plantId, productionDate });
            if (day) return sendSuccess(res, await loadDayDetail(day, req.role), 'Ngày sản xuất đã tồn tại');
        }
        throw error;
    }
};

export const updateProductionTimeSlots = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.id));
    const timeSlots = normalizeTimeSlots(req.body.timeSlots);
    const nextKeys = new Set(timeSlots.map((slot) => slot.key));
    const records = await ProductionLineRecord.find({ dayId: day._id })
        .select('runs entries qcEntries operationTracks operationEntries')
        .lean();
    const usedKeys = new Set<string>();
    records.forEach((record: any) => {
        record.entries?.forEach((entry: any) => usedKeys.add(String(entry.slotKey)));
        record.qcEntries?.forEach((entry: any) => usedKeys.add(String(entry.slotKey)));
        record.operationEntries?.forEach((entry: any) => usedKeys.add(String(entry.slotKey)));
        record.operationTracks?.forEach((track: any) => {
            if (track.startedSlotKey) usedKeys.add(String(track.startedSlotKey));
            if (track.endedSlotKey) usedKeys.add(String(track.endedSlotKey));
        });
        record.runs?.forEach((run: any) => {
            if (run.startedSlotKey) usedKeys.add(String(run.startedSlotKey));
            if (run.endedSlotKey) usedKeys.add(String(run.endedSlotKey));
        });
    });
    const removedUsedKey = [...usedKeys].find((key) => !nextKeys.has(key));
    if (removedUsedKey) {
        throw new BadRequestError(`Không thể xóa khung giờ ${removedUsedKey} vì đã có dữ liệu`);
    }
    const currentSlots = new Map(day.timeSlots.map((slot: any) => [String(slot.key), slot]));
    const changedUsedKey = [...usedKeys].find((key) => {
        const current: any = currentSlots.get(key);
        const next: any = timeSlots.find((slot) => slot.key === key);
        return (
            current &&
            next &&
            (Number(current.startMinute) !== Number(next.startMinute) ||
                Number(current.endMinute) !== Number(next.endMinute) ||
                next.isActive === false)
        );
    });
    if (changedUsedKey) {
        throw new BadRequestError(
            `Không thể đổi thời lượng hoặc tắt khung giờ ${changedUsedKey} vì đã phát sinh dữ liệu`
        );
    }

    day.timeSlots = timeSlots as any;
    day.updatedBy = req.userId as any;
    await day.save();
    emitProductionChange(day, { changeType: 'time-slots-updated' });
    return sendSuccess(res, await loadDayDetail(day, req.role), 'Đã cập nhật khung giờ');
};

export const addProductionDayLine = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.body.lineId);
    const line: any = await ProductionLine.findOne({ _id: lineId, plantId: day.plantId });
    if (!line) throw new NotFoundError('Không tìm thấy chuyền trong cơ sở này');
    if (line.isActive === false) throw new BadRequestError('Chuyền đang tắt, cần bật lại trước khi đưa vào ngày');

    const existing = await ProductionLineRecord.findOne({ dayId: day._id, lineId: line._id }).select('_id').lean();
    if (existing) throw new DuplicateError('Chuyền đã có trong ngày sản xuất này');

    await ProductionLineRecord.create({
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
        updatedBy: req.userId,
    });
    emitProductionChange(day, { changeType: 'day-line-added', lineId: String(line._id) });
    return sendSuccess(res, await loadDayDetail(day, req.role), `Đã thêm chuyền ${line.code} vào ngày`);
};

export const removeProductionDayLine = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    // Gỡ chuyền là thao tác biên chế, không được dùng để xoá số liệu đã báo.
    if (record.entries?.length || record.qcEntries?.length || record.operationEntries?.length) {
        throw new BadRequestError('Chuyền đã có sản lượng, công đoạn hoặc kết quả QC, không thể gỡ khỏi ngày');
    }
    if (record.runs?.length) throw new BadRequestError('Chuyền đã gán mã hàng, xóa mã hàng trước khi gỡ');

    await ProductionLineRecord.deleteOne({ _id: record._id });
    emitProductionChange(day, { changeType: 'day-line-removed', lineId });
    return sendSuccess(res, await loadDayDetail(day, req.role), `Đã gỡ chuyền ${record.lineCode} khỏi ngày`);
};

export const configureProductionLine = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');

    record.workerCount = req.body.workerCount;
    if (req.body.workerCountConfirmed) {
        record.workerCountConfirmedAt = new Date();
        record.workerCountConfirmedBy = req.userId;
    } else {
        record.workerCountConfirmedAt = undefined;
        record.workerCountConfirmedBy = undefined;
    }
    if (req.body.operationTrackingEnabled !== undefined) {
        record.operationTrackingEnabled = req.body.operationTrackingEnabled;
    }

    const hasPublishedPlanRuns = record.runs.some((run: any) => run.source === 'plan');
    if (req.body.itemId && !hasPublishedPlanRuns) {
        const item: any = await ProductionItem.findOne({
            _id: req.body.itemId,
            plantId: day.plantId,
            isActive: true,
        });
        if (!item) throw new NotFoundError('Không tìm thấy mã hàng đang hoạt động');
        const firstSlotKey = day.timeSlots.find((slot: any) => slot.isActive)?.key || day.timeSlots[0]?.key;
        const startSlotKey = req.body.startSlotKey || firstSlotKey;
        if (!day.timeSlots.some((slot: any) => slot.key === startSlotKey)) {
            throw new BadRequestError('Khung giờ bắt đầu không thuộc ngày sản xuất');
        }

        if (!record.runs.length) {
            record.runs.push({
                itemId: item._id,
                itemCode: item.code,
                itemName: item.name,
                unit: item.unit || 'SP',
                unitPriceSnapshot: item.unitPrice || 0,
                hourlyQuota: req.body.hourlyQuota,
                startedSlotKey: startSlotKey,
                status: 'active',
                createdBy: req.userId,
            });
        } else if (!record.entries.length) {
            const run = record.runs[0];
            run.itemId = item._id;
            run.itemCode = item.code;
            run.itemName = item.name;
            run.unit = item.unit || 'SP';
            run.unitPriceSnapshot = item.unitPrice || 0;
            run.hourlyQuota = req.body.hourlyQuota;
            run.startedSlotKey = startSlotKey;
            run.status = 'active';
            run.endedSlotKey = undefined;
            record.runs.splice(1);
        } else {
            const activeRun = [...record.runs].reverse().find((run: any) => run.status === 'active');
            if (!activeRun || String(activeRun.itemId) !== String(item._id)) {
                throw new BadRequestError('Chuyền đã có sản lượng; hãy dùng chức năng đổi mã hàng');
            }
            activeRun.hourlyQuota = req.body.hourlyQuota;
        }
    }

    if (req.body.operationTrackingEnabled !== undefined && record.runs.length) {
        const run = [...record.runs].reverse().find((item: any) => item.status === 'active') || record.runs[0];
        const item: any = await ProductionItem.findOne({ _id: run.itemId, plantId: day.plantId });
        if (!item) throw new NotFoundError('Không tìm thấy mã hàng của chuyền');
        const configs = await resolveOperationConfigs(day.plantId, item.operationTemplates || []);
        if (req.body.operationTrackingEnabled && !configs.length) {
            throw new BadRequestError('Mã hàng chưa có template công đoạn để theo dõi');
        }
        replaceOperationTracksForRun(record, run, configs, req.userId, Boolean(req.body.operationTrackingEnabled));
    }

    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'line-configured', lineId });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã cập nhật chuyền'
    );
};

export const createProductionRun = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const slotIndex = day.timeSlots.findIndex((slot: any) => slot.key === req.body.startedSlotKey && slot.isActive);
    if (slotIndex < 0) throw new BadRequestError('Khung giờ bắt đầu không hợp lệ');

    const item: any = await ProductionItem.findOne({
        _id: req.body.itemId,
        plantId: day.plantId,
        isActive: true,
    });
    if (!item) throw new NotFoundError('Không tìm thấy mã hàng đang hoạt động');

    const conflictingSlotKeys = findProductionRunStartConflicts(record.entries, req.body.startedSlotKey, day.timeSlots);
    if (conflictingSlotKeys.length) {
        const labels = conflictingSlotKeys
            .map((key) => day.timeSlots.find((slot: any) => String(slot.key) === key)?.label || key)
            .slice(0, 3);
        const remainingCount = Math.max(0, conflictingSlotKeys.length - labels.length);
        throw new BadRequestError(
            `Không thể áp dụng ngược từ khung đã có sản lượng (${labels.join(', ')}${remainingCount ? ` và ${remainingCount} khung khác` : ''}). Hãy chọn khung chưa nhập tiếp theo hoặc xóa số liệu cần sửa trước.`
        );
    }

    const previousSlotKey = day.timeSlots[Math.max(0, slotIndex - 1)]?.key || req.body.startedSlotKey;
    record.runs.forEach((run: any) => {
        if (run.status === 'active') {
            run.status = 'closed';
            run.endedSlotKey = previousSlotKey;
            closeOperationTracksForRun(record, run._id, previousSlotKey);
        }
    });
    record.runs.push({
        itemId: item._id,
        itemCode: item.code,
        itemName: item.name,
        unit: item.unit || 'SP',
        unitPriceSnapshot: item.unitPrice || 0,
        hourlyQuota: req.body.hourlyQuota,
        startedSlotKey: req.body.startedSlotKey,
        status: 'active',
        createdBy: req.userId,
    });
    const newRun = record.runs[record.runs.length - 1];
    if (record.operationTrackingEnabled && item.operationTemplates?.length) {
        const configs = await resolveOperationConfigs(day.plantId, item.operationTemplates);
        replaceOperationTracksForRun(record, newRun, configs, req.userId, true);
    }
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'run-created', lineId, slotKey: req.body.startedSlotKey });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã bắt đầu mã hàng mới',
        StatusCodes.CREATED
    );
};

export const configureProductionOperationTracks = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const run = record.runs.id(req.body.runId);
    if (!run) throw new NotFoundError('Mã hàng không thuộc chuyền này');
    const configs = req.body.enabled ? await resolveOperationConfigs(day.plantId, req.body.operations) : [];
    replaceOperationTracksForRun(record, run, configs, req.userId, req.body.enabled);
    record.operationTrackingEnabled = req.body.enabled;
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'operation-tracks-updated', lineId, runId: String(run._id) });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        req.body.enabled ? 'Đã cập nhật công đoạn theo dõi' : 'Đã tắt theo dõi công đoạn'
    );
};

export const correctProductionLineSetup = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    if (!record.runs.length) throw new BadRequestError('Chuyền chưa có mã hàng để sửa');
    if (record.runs.some((run: any) => run.source === 'plan')) {
        throw new BadRequestError('Chuyền đang dùng kế hoạch đã phát hành; hãy sửa và phát hành lại kế hoạch');
    }
    if (record.operationEntries?.length) {
        throw new BadRequestError('Chuyền đã có sản lượng công đoạn; cần xóa số công đoạn trước khi sửa toàn bộ mã');
    }

    const item: any = await ProductionItem.findOne({
        _id: req.body.itemId,
        plantId: day.plantId,
        isActive: true,
    });
    if (!item) throw new NotFoundError('Không tìm thấy mã hàng đang hoạt động');

    const activeSlots = day.timeSlots.filter((slot: any) => slot.isActive !== false);
    const firstSlotKey = activeSlots[0]?.key;
    if (!firstSlotKey) throw new BadRequestError('Ngày sản xuất chưa có khung giờ hoạt động');

    const slotIndexByKey = new Map(day.timeSlots.map((slot: any, index: number) => [String(slot.key), index]));
    const canonicalRun = [...record.runs].sort((left: any, right: any) => {
        const leftIndex = Number(slotIndexByKey.get(String(left.startedSlotKey)) ?? Number.MAX_SAFE_INTEGER);
        const rightIndex = Number(slotIndexByKey.get(String(right.startedSlotKey)) ?? Number.MAX_SAFE_INTEGER);
        return (
            leftIndex - rightIndex || new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
        );
    })[0];
    const canonicalRunId = canonicalRun._id;
    const previousItemCodes = [...new Set(record.runs.map((run: any) => String(run.itemCode)).filter(Boolean))];
    const previousUnitPrices = [...new Set(record.runs.map((run: any) => Number(run.unitPriceSnapshot || 0)))];

    record.operationTracks.splice(0);

    const entryBySlot = new Map<string, any>();
    [...record.entries].forEach((entry: any) => {
        const existingEntry = entryBySlot.get(String(entry.slotKey));
        if (existingEntry) {
            existingEntry.quantity = Number(existingEntry.quantity || 0) + Number(entry.quantity || 0);
            const notes = [existingEntry.note, entry.note].filter(Boolean);
            existingEntry.note = [...new Set(notes)].join(' · ').slice(0, 500) || undefined;
            existingEntry.updatedBy = req.userId;
            existingEntry.updatedAt = new Date();
            entry.deleteOne();
            return;
        }
        entry.runId = canonicalRunId;
        entry.updatedBy = req.userId;
        entry.updatedAt = new Date();
        entryBySlot.set(String(entry.slotKey), entry);
    });
    for (let index = record.runs.length - 1; index >= 0; index -= 1) {
        if (String(record.runs[index]._id) !== String(canonicalRunId)) record.runs[index].deleteOne();
    }
    canonicalRun.itemId = item._id;
    canonicalRun.itemCode = item.code;
    canonicalRun.itemName = item.name;
    canonicalRun.unit = item.unit || 'SP';
    canonicalRun.unitPriceSnapshot = item.unitPrice || 0;
    canonicalRun.hourlyQuota = req.body.hourlyQuota;
    canonicalRun.startedSlotKey = firstSlotKey;
    canonicalRun.endedSlotKey = undefined;
    canonicalRun.status = 'active';

    if (record.operationTrackingEnabled && item.operationTemplates?.length) {
        const configs = await resolveOperationConfigs(day.plantId, item.operationTemplates);
        replaceOperationTracksForRun(record, canonicalRun, configs, req.userId, true);
    }

    record.setupCorrections.push({
        reason: req.body.reason,
        previousItemCodes,
        previousUnitPrices,
        nextItemCode: item.code,
        nextUnitPrice: item.unitPrice || 0,
        nextHourlyQuota: req.body.hourlyQuota,
        correctedBy: req.userId,
        correctedAt: new Date(),
    });
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'line-configured', lineId });

    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        `Đã sửa mã cài nhầm thành ${item.code} và tính lại toàn bộ ngày`
    );
};

export const deleteProductionRun = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const runId = String(req.params.runId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const run = record.runs.id(runId);
    if (!run) throw new NotFoundError('Không tìm thấy đợt mã hàng');
    if (record.entries.some((entry: any) => String(entry.runId) === runId)) {
        throw new BadRequestError('Không thể xóa mã hàng đã có sản lượng');
    }
    const operationTrackIds = new Set(
        record.operationTracks
            .filter((track: any) => String(track.sourceRunId) === runId)
            .map((track: any) => String(track._id))
    );
    if (record.operationEntries.some((entry: any) => operationTrackIds.has(String(entry.trackId)))) {
        throw new BadRequestError('Không thể xóa mã hàng đã có sản lượng công đoạn');
    }
    [...record.operationTracks]
        .filter((track: any) => String(track.sourceRunId) === runId)
        .forEach((track: any) => track.deleteOne());
    const wasActive = run.status === 'active';
    run.deleteOne();
    if (wasActive && record.runs.length) {
        const lastRun = record.runs[record.runs.length - 1];
        lastRun.status = 'active';
        lastRun.endedSlotKey = undefined;
        record.operationTracks
            .filter((track: any) => String(track.sourceRunId) === String(lastRun._id))
            .forEach((track: any) => {
                track.status = 'active';
                track.endedSlotKey = undefined;
            });
    }
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'run-deleted', lineId });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã xóa mã hàng khỏi ngày sản xuất'
    );
};

export const upsertHourlyProductionEntry = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const slotKey = String(req.params.slotKey);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const slotIndex = day.timeSlots.findIndex((slot: any) => slot.key === slotKey && slot.isActive);
    if (slotIndex < 0) throw new BadRequestError('Khung giờ không hợp lệ hoặc đã tắt');
    const run = record.runs.id(req.body.runId);
    if (!run) throw new NotFoundError('Mã hàng không thuộc chuyền này');
    const existing = record.entries.find(
        (entry: any) => entry.slotKey === slotKey && String(entry.runId) === String(run._id)
    );
    const startIndex = day.timeSlots.findIndex((slot: any) => slot.key === run.startedSlotKey);
    const endIndex = run.endedSlotKey
        ? day.timeSlots.findIndex((slot: any) => slot.key === run.endedSlotKey)
        : day.timeSlots.length - 1;
    // Cho phép sửa chính bản ghi lịch sử ngay cả khi khoảng run từng bị đóng sai.
    // Chỉ chặn tạo mới ngoài khoảng hoạt động của mã hàng.
    if (!existing && (slotIndex < startIndex || (endIndex >= 0 && slotIndex > endIndex))) {
        throw new BadRequestError('Mã hàng không hoạt động tại khung giờ này');
    }

    const syncDecision = decideProductionEntrySync(existing, {
        clientMutationId: req.body.clientMutationId,
        expectedUpdatedAt: req.body.expectedUpdatedAt,
        hasExpectedUpdatedAt: Object.prototype.hasOwnProperty.call(req.body, 'expectedUpdatedAt'),
    });

    if (syncDecision.action === 'conflict') {
        throw new DuplicateError(
            'Số liệu khung giờ này vừa được cập nhật từ thiết bị khác. Dữ liệu mới nhất đã được giữ lại, vui lòng kiểm tra rồi lưu lại.'
        );
    }

    if (syncDecision.action === 'idempotent') {
        const detail: any = await loadDayDetail(day, req.role);
        return sendSuccess(
            res,
            detail.lines.find((line: any) => line.lineId === lineId),
            'Sản lượng đã được đồng bộ trước đó'
        );
    }

    if (existing) {
        existing.quantity = req.body.quantity;
        existing.note = req.body.note;
        existing.updatedBy = req.userId;
        existing.updatedAt = new Date();
        existing.lastClientMutationId = req.body.clientMutationId;
    } else {
        record.entries.push({
            slotKey,
            runId: run._id,
            quantity: req.body.quantity,
            note: req.body.note,
            enteredBy: req.userId,
            enteredAt: new Date(),
            updatedBy: req.userId,
            updatedAt: new Date(),
            lastClientMutationId: req.body.clientMutationId,
        });
    }
    record.updatedBy = req.userId;
    try {
        await saveRecord(record);
    } catch (error) {
        if (error instanceof DuplicateError && req.body.clientMutationId) {
            const latestRecord: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
            const latestEntry = latestRecord?.entries?.find(
                (entry: any) =>
                    entry.slotKey === slotKey &&
                    String(entry.runId) === String(run._id) &&
                    entry.lastClientMutationId === req.body.clientMutationId
            );
            if (latestEntry) {
                const detail: any = await loadDayDetail(day, req.role);
                return sendSuccess(
                    res,
                    detail.lines.find((line: any) => line.lineId === lineId),
                    'Sản lượng đã được đồng bộ trước đó'
                );
            }
        }
        throw error;
    }
    emitProductionChange(day, {
        changeType: 'entry-updated',
        lineId,
        slotKey,
        actorId: req.userId,
        clientMutationId: req.body.clientMutationId,
    });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã lưu sản lượng'
    );
};

export const deleteHourlyProductionEntry = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const entryId = String(req.params.entryId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const entry = record.entries.id(entryId);
    if (!entry) throw new NotFoundError('Không tìm thấy số liệu sản lượng');
    const slotKey = entry.slotKey;
    entry.deleteOne();
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'entry-deleted', lineId, slotKey });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã xóa số liệu sản lượng'
    );
};

export const upsertHourlyOperationEntries = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const slotKey = String(req.params.slotKey);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    if (!day.timeSlots.some((slot: any) => slot.key === slotKey && slot.isActive)) {
        throw new BadRequestError('Khung giờ không hợp lệ hoặc đã tắt');
    }

    const trackById = new Map(record.operationTracks.map((track: any) => [String(track._id), track]));
    const prepared = req.body.entries.map((input: any) => {
        const track: any = trackById.get(String(input.trackId));
        if (!track) throw new NotFoundError('Công đoạn không thuộc chuyền này');
        const slotEntries = record.operationEntries.filter(
            (entry: any) => String(entry.slotKey) === slotKey && String(entry.trackId) === String(track._id)
        );
        const existing = [...slotEntries].sort(
            (left: any, right: any) =>
                new Date(right.updatedAt || right.enteredAt || 0).getTime() -
                new Date(left.updatedAt || left.enteredAt || 0).getTime()
        )[0];
        const decision = decideProductionEntrySync(existing, {
            clientMutationId: input.clientMutationId,
            expectedUpdatedAt: input.expectedUpdatedAt,
            hasExpectedUpdatedAt: Object.prototype.hasOwnProperty.call(input, 'expectedUpdatedAt'),
        });
        return { input, track, slotEntries, existing, decision };
    });

    const conflicts = prepared.filter((item: any) => item.decision.action === 'conflict');
    if (conflicts.length) {
        const names = conflicts
            .slice(0, 3)
            .map((item: any) => item.track.operationName)
            .join(', ');
        throw new DuplicateError(
            `Số liệu công đoạn vừa được cập nhật từ thiết bị khác (${names}). Vui lòng kiểm tra dữ liệu mới nhất.`
        );
    }

    let changed = false;
    prepared.forEach(({ input, track, slotEntries, existing, decision }: any) => {
        if (decision.action === 'idempotent') return;
        changed = true;
        if (existing) {
            existing.quantity = input.quantity;
            existing.note = input.note;
            existing.updatedBy = req.userId;
            existing.updatedAt = new Date();
            existing.lastClientMutationId = input.clientMutationId;
            slotEntries.forEach((entry: any) => {
                if (String(entry._id) !== String(existing._id)) entry.deleteOne();
            });
            return;
        }
        record.operationEntries.push({
            slotKey,
            trackId: track._id,
            quantity: input.quantity,
            note: input.note,
            enteredBy: req.userId,
            enteredAt: new Date(),
            updatedBy: req.userId,
            updatedAt: new Date(),
            lastClientMutationId: input.clientMutationId,
        });
    });

    if (changed) {
        record.updatedBy = req.userId;
        await saveRecord(record);
        emitProductionChange(day, {
            changeType: 'operation-entries-updated',
            lineId,
            slotKey,
            actorId: req.userId,
        });
    }
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        changed ? 'Đã lưu sản lượng công đoạn' : 'Sản lượng công đoạn đã được đồng bộ trước đó'
    );
};

export const deleteHourlyOperationEntry = async (req: Request, res: Response) => {
    const day = await loadDayForWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const entryId = String(req.params.entryId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const entry = record.operationEntries.id(entryId);
    if (!entry) throw new NotFoundError('Không tìm thấy sản lượng công đoạn');
    const slotKey = String(entry.slotKey);
    const trackId = String(entry.trackId);
    [...record.operationEntries]
        .filter((item: any) => String(item.slotKey) === slotKey && String(item.trackId) === trackId)
        .forEach((item: any) => item.deleteOne());
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'operation-entry-deleted', lineId, slotKey, trackId });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã xóa sản lượng công đoạn'
    );
};

export const upsertHourlyQcEntry = async (req: Request, res: Response) => {
    const day = await loadDayForQcWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const slotKey = String(req.params.slotKey);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');

    const slotIndex = day.timeSlots.findIndex((slot: any) => slot.key === slotKey && slot.isActive);
    if (slotIndex < 0) throw new BadRequestError('Khung giờ không hợp lệ hoặc đã tắt');
    const totalQuantity = Number(req.body.passedQuantity) + Number(req.body.defectQuantity);
    const slotEntries = record.qcEntries.filter((entry: any) => String(entry.slotKey) === slotKey);
    // Bản cũ có thể có nhiều entry trong cùng giờ vì từng gắn theo runId. Chọn
    // bản mới nhất làm phiên bản xung đột, sau đó chuẩn hóa về đúng một entry.
    const existing = [...slotEntries].sort(
        (left: any, right: any) =>
            new Date(right.updatedAt || right.enteredAt || 0).getTime() -
            new Date(left.updatedAt || left.enteredAt || 0).getTime()
    )[0];

    const syncDecision = decideProductionEntrySync(existing, {
        clientMutationId: req.body.clientMutationId,
        expectedUpdatedAt: req.body.expectedUpdatedAt,
        hasExpectedUpdatedAt: Object.prototype.hasOwnProperty.call(req.body, 'expectedUpdatedAt'),
    });
    if (syncDecision.action === 'conflict') {
        throw new DuplicateError(
            'Kết quả QC vừa được cập nhật từ thiết bị khác. Dữ liệu mới nhất đã được giữ lại, vui lòng kiểm tra rồi lưu lại.'
        );
    }
    if (syncDecision.action === 'idempotent') {
        const detail: any = await loadDayDetail(day, req.role);
        return sendSuccess(
            res,
            detail.lines.find((line: any) => line.lineId === lineId),
            'Kết quả QC đã được đồng bộ trước đó'
        );
    }

    if (existing) {
        existing.passedQuantity = req.body.passedQuantity;
        existing.defectQuantity = req.body.defectQuantity;
        existing.totalQuantity = totalQuantity;
        existing.runId = undefined;
        existing.note = req.body.note;
        existing.updatedBy = req.userId;
        existing.updatedAt = new Date();
        existing.lastClientMutationId = req.body.clientMutationId;
        slotEntries.forEach((entry: any) => {
            if (String(entry._id) !== String(existing._id)) entry.deleteOne();
        });
    } else {
        record.qcEntries.push({
            slotKey,
            passedQuantity: req.body.passedQuantity,
            defectQuantity: req.body.defectQuantity,
            totalQuantity,
            note: req.body.note,
            enteredBy: req.userId,
            enteredAt: new Date(),
            updatedBy: req.userId,
            updatedAt: new Date(),
            lastClientMutationId: req.body.clientMutationId,
        });
    }
    record.updatedBy = req.userId;

    try {
        await saveRecord(record);
    } catch (error) {
        if (error instanceof DuplicateError && req.body.clientMutationId) {
            const latestRecord: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
            const latestEntry = latestRecord?.qcEntries?.find(
                (entry: any) => entry.slotKey === slotKey && entry.lastClientMutationId === req.body.clientMutationId
            );
            if (latestEntry) {
                const detail: any = await loadDayDetail(day, req.role);
                return sendSuccess(
                    res,
                    detail.lines.find((line: any) => line.lineId === lineId),
                    'Kết quả QC đã được đồng bộ trước đó'
                );
            }
        }
        throw error;
    }

    emitProductionChange(day, {
        changeType: 'qc-entry-updated',
        lineId,
        slotKey,
        actorId: req.userId,
        clientMutationId: req.body.clientMutationId,
    });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã lưu kết quả QC'
    );
};

export const deleteHourlyQcEntry = async (req: Request, res: Response) => {
    const day = await loadDayForQcWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const entryId = String(req.params.entryId);
    const record: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId });
    if (!record) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');
    const entry = record.qcEntries.id(entryId);
    if (!entry) throw new NotFoundError('Không tìm thấy kết quả QC');
    const slotKey = entry.slotKey;
    // Xóa cả các entry legacy cùng khung giờ để ô QC thực sự trở về chưa nhập.
    [...record.qcEntries]
        .filter((item: any) => String(item.slotKey) === String(slotKey))
        .forEach((item: any) => item.deleteOne());
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'qc-entry-deleted', lineId, slotKey });
    const detail: any = await loadDayDetail(day, req.role);
    return sendSuccess(
        res,
        detail.lines.find((line: any) => line.lineId === lineId),
        'Đã xóa kết quả QC'
    );
};
