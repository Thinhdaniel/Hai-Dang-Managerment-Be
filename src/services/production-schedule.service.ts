import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionScheduleTemplate from '@/models/ProductionScheduleTemplate';
import type { Request, Response } from 'express';
import { sendSuccess } from './service.helpers';
import {
    defaultProductionScheduleForWeekday,
    normalizeProductionTimeSlots,
    productionWeekdayFromDate,
    PRODUCTION_WEEKDAY_LABELS,
    summarizeProductionScheduleSlots,
} from './production-schedule.helpers';

const userPlantId = (req: Request): string => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const resolvePlantId = (req: Request, input?: unknown) => {
    const plantId = String(input || userPlantId(req) || '');
    if (!plantId) throw new BadRequestError('Cần chọn cơ sở');
    if (![USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE) && userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền cấu hình lịch sản xuất của cơ sở này');
    }
    return plantId;
};

const assertWeekday = (input: unknown) => {
    const weekday = Number(input);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new BadRequestError('Thứ trong tuần không hợp lệ');
    }
    return weekday;
};

const serializeTemplate = (template: any, plantId: string, weekday: number) => {
    const defaults = defaultProductionScheduleForWeekday(weekday);
    const timeSlots = normalizeProductionTimeSlots(
        template?.timeSlots?.length ? template.timeSlots : defaults.timeSlots
    );
    return {
        id: template?._id ? String(template._id) : undefined,
        plantId,
        weekday,
        weekdayLabel: PRODUCTION_WEEKDAY_LABELS[weekday],
        isWorkingDay: template ? template.isWorkingDay !== false : defaults.isWorkingDay,
        timeSlots,
        source: template ? ('custom' as const) : ('system_default' as const),
        revision: Number(template?.revision || 0),
        summary: summarizeProductionScheduleSlots(timeSlots),
        updatedAt: template?.updatedAt ? new Date(template.updatedAt).toISOString() : undefined,
    };
};

const assertPlantExists = async (plantId: string) => {
    const plant = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } })
        .select('_id')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
};

export const resolveProductionScheduleForDate = async (plantId: string, productionDate: string) => {
    const weekday = productionWeekdayFromDate(productionDate);
    const template: any = await ProductionScheduleTemplate.findOne({ plantId, weekday }).lean();
    const serialized = serializeTemplate(template, plantId, weekday);
    return {
        timeSlots: serialized.timeSlots,
        source: template ? ('weekly_template' as const) : ('system_default' as const),
        weekday,
        revision: serialized.revision,
        isWorkingDay: serialized.isWorkingDay,
    };
};

export const listProductionScheduleTemplates = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    await assertPlantExists(plantId);
    const templates: any[] = await ProductionScheduleTemplate.find({ plantId }).lean();
    const byWeekday = new Map(templates.map((template) => [Number(template.weekday), template]));
    return sendSuccess(
        res,
        Array.from({ length: 7 }, (_, weekday) => serializeTemplate(byWeekday.get(weekday), plantId, weekday)),
        'Đã lấy lịch làm việc theo tuần'
    );
};

export const updateProductionScheduleTemplate = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const weekday = assertWeekday(req.params.weekday);
    await assertPlantExists(plantId);
    const normalizedSlots = normalizeProductionTimeSlots(req.body.timeSlots);
    const timeSlots = req.body.isWorkingDay
        ? normalizedSlots
        : normalizedSlots.map((slot) => ({ ...slot, isActive: false }));
    if (req.body.isWorkingDay && !timeSlots.some((slot) => slot.isActive && slot.kind === 'regular')) {
        throw new BadRequestError('Ngày làm việc cần có ít nhất một khung giờ thường đang bật');
    }
    let template: any = await ProductionScheduleTemplate.findOne({ plantId, weekday });
    if (template) {
        template.isWorkingDay = req.body.isWorkingDay;
        template.timeSlots = timeSlots;
        template.updatedBy = req.userId;
        template.revision = Number(template.revision || 0) + 1;
        await template.save();
    } else {
        template = await ProductionScheduleTemplate.create({
            plantId,
            weekday,
            isWorkingDay: req.body.isWorkingDay,
            timeSlots,
            revision: 1,
            createdBy: req.userId,
            updatedBy: req.userId,
        });
    }
    return sendSuccess(
        res,
        serializeTemplate(template, plantId, weekday),
        `Đã lưu lịch ${PRODUCTION_WEEKDAY_LABELS[weekday]}`
    );
};

export const resetProductionScheduleTemplate = async (req: Request, res: Response) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const weekday = assertWeekday(req.params.weekday);
    await assertPlantExists(plantId);
    await ProductionScheduleTemplate.deleteOne({ plantId, weekday });
    return sendSuccess(
        res,
        serializeTemplate(null, plantId, weekday),
        `Đã khôi phục lịch mặc định ${PRODUCTION_WEEKDAY_LABELS[weekday]}`
    );
};
