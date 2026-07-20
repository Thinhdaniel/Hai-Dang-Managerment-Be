import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionPlan from '@/models/ProductionPlan';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { buildProductionDayDetail } from './production.helpers';
import { buildProductionReportWorkbook } from './production-report-export.service';
import { buildProductionReport } from './production-report.helpers';
import { sendSuccess } from './service.helpers';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseDate = (value: unknown, label: string) => {
    const normalized = String(value || '');
    if (!DATE_PATTERN.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00.000Z`))) {
        throw new BadRequestError(`${label} không hợp lệ`);
    }
    return normalized;
};

const addDays = (date: string, amount: number) => {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
};

const resolveRange = (req: Request) => {
    const to = parseDate(req.query.to, 'Ngày kết thúc');
    const from = parseDate(req.query.from, 'Ngày bắt đầu');
    if (from > to) throw new BadRequestError('Khoảng ngày báo cáo không hợp lệ');
    const days = Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;
    if (days > 366) throw new BadRequestError('Khoảng báo cáo tối đa là 366 ngày');
    const previousTo = addDays(from, -1);
    const previousFrom = addDays(previousTo, -(days - 1));
    return { from, to, days, previousFrom, previousTo };
};

const resolvePlant = async (req: Request) => {
    const requested = String(req.query.plantId || req.user?.plantId?._id || req.user?.plantId || '');
    if (!mongoose.isValidObjectId(requested)) throw new BadRequestError('Cơ sở không hợp lệ');
    const canSwitchPlant = [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE);
    const ownPlantId = String(req.user?.plantId?._id || req.user?.plantId || '');
    if (!canSwitchPlant && requested !== ownPlantId) {
        throw new UnAuthorizedError('Bạn chỉ được xem báo cáo của cơ sở được phân công');
    }
    const plant: any = await Plant.findById(requested).select('name code').lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: requested, name: plant.name, code: plant.code };
};

const loadDetails = async (days: any[]) => {
    if (!days.length) return [];
    const records = await ProductionLineRecord.find({ dayId: { $in: days.map((day) => day._id) } })
        .sort({ productionDate: 1, sortOrder: 1, lineCode: 1 })
        .lean();
    const recordsByDay = new Map<string, any[]>();
    records.forEach((record: any) => {
        const key = String(record.dayId);
        const current = recordsByDay.get(key) || [];
        current.push(record);
        recordsByDay.set(key, current);
    });
    return days.map((day) => buildProductionDayDetail(day, recordsByDay.get(String(day._id)) || []));
};

const loadReport = async (req: Request, exceptionLimit = 200) => {
    const [{ from, to, previousFrom, previousTo }, plant] = await Promise.all([resolveRange(req), resolvePlant(req)]);
    const scope = req.query.scope === 'locked' ? 'locked' : 'all';
    const dateFloor = previousFrom;
    const dayFilter: Record<string, any> = {
        plantId: plant.id,
        productionDate: { $gte: dateFloor, $lte: to },
    };
    if (scope === 'locked') dayFilter.status = 'locked';

    const [days, plans] = await Promise.all([
        ProductionDay.find(dayFilter).sort({ productionDate: 1 }).lean(),
        ProductionPlan.find({
            plantId: plant.id,
            productionDate: { $gte: dateFloor, $lte: to },
            status: 'published',
        })
            .sort({ productionDate: 1 })
            .lean(),
    ]);
    const details = await loadDetails(days);
    const currentDetails = details.filter((day) => day.productionDate >= from && day.productionDate <= to);
    const previousDetails = details.filter(
        (day) => day.productionDate >= previousFrom && day.productionDate <= previousTo
    );
    const currentPlans = plans.filter((plan) => plan.productionDate >= from && plan.productionDate <= to);
    const previousPlans = plans.filter(
        (plan) => plan.productionDate >= previousFrom && plan.productionDate <= previousTo
    );
    const financialsVisible = [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER].includes(req.role as USER_ROLE);

    return buildProductionReport(currentDetails, currentPlans, {
        plantId: plant.id,
        plantName: plant.name,
        plantCode: plant.code,
        from,
        to,
        scope,
        financialsVisible,
        previousFrom,
        previousTo,
        previousDetails,
        previousPlans,
        exceptionLimit,
    });
};

export const getProductionReport = async (req: Request, res: Response) => {
    const report = await loadReport(req);
    return sendSuccess(
        res,
        report,
        report.summary.dayCount
            ? `Đã tổng hợp ${report.summary.dayCount} ngày sản xuất`
            : 'Chưa có dữ liệu sản xuất trong khoảng đã chọn'
    );
};

export const exportProductionReport = async (req: Request, res: Response) => {
    const report = await loadReport(req, Number.POSITIVE_INFINITY);
    const workbook = await buildProductionReportWorkbook(report);
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `production-report-${report.meta.from}-${report.meta.to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};
