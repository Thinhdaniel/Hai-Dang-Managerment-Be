import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionPlan from '@/models/ProductionPlan';
import { buildPaginatedResponse } from '@/utils/pagination';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { sendSuccess } from './service.helpers';
import {
    buildProductionDayDetail,
    DEFAULT_PRODUCTION_TIME_SLOTS,
    redactProductionFinancials,
    serializeProductionItem,
    serializeProductionLine,
    validateProductionDayForSubmission,
} from './production.helpers';
import { buildProductionWorkbook } from './production-export.service';
import { buildProductionForecast } from './production-forecast.helpers';
import { buildProductionMonitor } from './production-monitor.helpers';
import { serializeProductionPlan } from './production-plan.service';

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
        .map((slot) => ({
            key: String(slot.key),
            label: String(slot.label),
            startMinute: Number(slot.startMinute),
            endMinute: Number(slot.endMinute),
            kind: slot.kind || 'regular',
            isActive: slot.isActive !== false,
        }))
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

const ensureDayLineRecords = async (day: any) => {
    if (day.status && day.status !== 'draft') return;
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
                },
            },
            upsert: true,
        },
    }));
    // Mongoose suy luận mảng subdocument thành DocumentArray ở bulkWrite dù payload chỉ dùng $setOnInsert.
    await ProductionLineRecord.bulkWrite(operations as any, { ordered: false });
};

const loadDayDetail = async (dayInput: any, role?: string) => {
    const day = typeof dayInput?.toObject === 'function' ? dayInput : await ProductionDay.findById(dayInput);
    if (!day) throw new NotFoundError('Không tìm thấy ngày sản xuất');
    await ensureDayLineRecords(day);
    await day.populate(DAY_ACTOR_PATHS);
    const records = await ProductionLineRecord.find({ dayId: day._id })
        .sort({ sortOrder: 1, lineCode: 1 })
        .populate(RECORD_ACTOR_PATHS);
    const detail = buildProductionDayDetail(day, records);
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

const emitProductionChange = (day: any, payload: Record<string, unknown>) => {
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
    const item: any = await ProductionItem.findById(req.params.id);
    if (!item) throw new NotFoundError('Không tìm thấy mã hàng');
    assertPlantAccess(req, String(item.plantId));

    if (req.body.unitPrice !== undefined && Number(req.body.unitPrice) !== Number(item.unitPrice)) {
        const now = new Date();
        const currentPrice = item.priceHistory?.[item.priceHistory.length - 1];
        if (currentPrice && !currentPrice.effectiveTo) currentPrice.effectiveTo = now;
        item.priceHistory.push({ unitPrice: req.body.unitPrice, effectiveFrom: now, updatedBy: req.userId });
    }
    Object.assign(item, req.body, {
        ...(req.body.code ? { code: String(req.body.code).trim().toUpperCase() } : {}),
        updatedBy: req.userId,
    });
    try {
        await item.save();
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Mã hàng đã tồn tại trong cơ sở');
        throw error;
    }
    return sendSuccess(res, serializeProductionItem(item), 'Đã cập nhật mã hàng');
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

    const monthKey = String(day.productionDate).slice(0, 7);
    const [year, month] = monthKey.split('-').map(Number);
    const monthEnd = `${monthKey}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
    const [monthDays, lines, items, plan] = await Promise.all([
        ProductionDay.find({
            plantId: day.plantId,
            productionDate: { $gte: `${monthKey}-01`, $lte: monthEnd },
        }).sort({ productionDate: 1 }),
        ProductionLine.find({ plantId: day.plantId }).sort({ sortOrder: 1, code: 1 }).lean(),
        ProductionItem.find({ plantId: day.plantId }).sort({ code: 1 }).lean(),
        ProductionPlan.findOne({ plantId: day.plantId, productionDate: day.productionDate }),
    ]);
    const monthDetails = await buildDetailsForDays(monthDays);
    const workbook = await buildProductionWorkbook({
        detail,
        monthDetails,
        lines,
        items,
        plan: plan ? serializeProductionPlan(plan) : undefined,
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `bao-cao-san-luong-${day.productionDate}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};

export const createProductionDay = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const productionDate = assertValidDate(req.body.productionDate);
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
    const records = await ProductionLineRecord.find({ dayId: day._id }).select('runs entries').lean();
    const usedKeys = new Set<string>();
    records.forEach((record: any) => {
        record.entries?.forEach((entry: any) => usedKeys.add(String(entry.slotKey)));
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

    const previousSlotKey = day.timeSlots[Math.max(0, slotIndex - 1)]?.key || req.body.startedSlotKey;
    record.runs.forEach((run: any) => {
        if (run.status === 'active') {
            run.status = 'closed';
            run.endedSlotKey = previousSlotKey;
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
    const wasActive = run.status === 'active';
    run.deleteOne();
    if (wasActive && record.runs.length) {
        const lastRun = record.runs[record.runs.length - 1];
        lastRun.status = 'active';
        lastRun.endedSlotKey = undefined;
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
    const startIndex = day.timeSlots.findIndex((slot: any) => slot.key === run.startedSlotKey);
    const endIndex = run.endedSlotKey
        ? day.timeSlots.findIndex((slot: any) => slot.key === run.endedSlotKey)
        : day.timeSlots.length - 1;
    if (slotIndex < startIndex || (endIndex >= 0 && slotIndex > endIndex)) {
        throw new BadRequestError('Mã hàng không hoạt động tại khung giờ này');
    }

    const existing = record.entries.find(
        (entry: any) => entry.slotKey === slotKey && String(entry.runId) === String(run._id)
    );
    if (existing) {
        existing.quantity = req.body.quantity;
        existing.note = req.body.note;
        existing.updatedBy = req.userId;
        existing.updatedAt = new Date();
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
        });
    }
    record.updatedBy = req.userId;
    await saveRecord(record);
    emitProductionChange(day, { changeType: 'entry-updated', lineId, slotKey });
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
