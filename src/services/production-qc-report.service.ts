import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionQcRecord from '@/models/ProductionQcRecord';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { loadConfirmedProductionOpeningBalances } from './production-opening-balance.service';
import { loadConfirmedProductionQcOpeningBalances } from './production-qc-opening-balance.service';
import { buildProductionQcReportWorkbook } from './production-qc-report-export.service';
import { buildProductionQcReport } from './production-qc-report.helpers';
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
    const from = parseDate(req.query.from, 'Ngày bắt đầu');
    const to = parseDate(req.query.to, 'Ngày kết thúc');
    if (from > to) throw new BadRequestError('Khoảng ngày báo cáo không hợp lệ');
    const days = Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;
    if (days > 366) throw new BadRequestError('Khoảng báo cáo tối đa là 366 ngày');
    return { from, to };
};

const resolvePlant = async (req: Request) => {
    const requested = String(req.query.plantId || req.user?.plantId?._id || req.user?.plantId || '');
    if (!mongoose.isValidObjectId(requested)) throw new BadRequestError('Cơ sở không hợp lệ');
    const canSwitchPlant = [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE);
    const ownPlantId = String(req.user?.plantId?._id || req.user?.plantId || '');
    if (!canSwitchPlant && requested !== ownPlantId) {
        throw new UnAuthorizedError('Bạn chỉ được xem báo cáo QC của cơ sở được phân công');
    }
    const plant: any = await Plant.findById(requested).select('name code').lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: requested, name: plant.name, code: plant.code };
};

const resolveFilters = (req: Request) => {
    const itemId = String(req.query.itemId || '');
    const lineId = String(req.query.lineId || '');
    if (itemId && !mongoose.isValidObjectId(itemId)) throw new BadRequestError('Mã hàng lọc không hợp lệ');
    if (lineId && !mongoose.isValidObjectId(lineId)) throw new BadRequestError('Chuyền lọc không hợp lệ');
    return {
        ...(itemId ? { itemId } : {}),
        ...(lineId ? { lineId } : {}),
        ...(req.query.orderCode ? { orderCode: String(req.query.orderCode) } : {}),
    };
};

const loadReport = async (req: Request) => {
    const [{ from, to }, plant] = await Promise.all([resolveRange(req), resolvePlant(req)]);
    const [productionOpening, qcOpening, firstTrackedDay] = await Promise.all([
        loadConfirmedProductionOpeningBalances(plant.id),
        loadConfirmedProductionQcOpeningBalances(plant.id),
        ProductionDay.findOne({ plantId: plant.id }).sort({ productionDate: 1 }).select('productionDate').lean(),
    ]);
    const cutoffDate = String(qcOpening.coverage.cutoffDate || productionOpening.coverage.cutoffDate || '');
    const floor = cutoffDate ? addDays(cutoffDate, 1) : from;
    const dateFilter = { $gte: floor, $lte: to };
    const [lineRecords, qcRecords] = await Promise.all([
        ProductionLineRecord.find({ plantId: plant.id, productionDate: dateFilter })
            .sort({ productionDate: 1, sortOrder: 1, lineCode: 1 })
            .lean(),
        ProductionQcRecord.find({ plantId: plant.id, productionDate: dateFilter })
            .sort({ productionDate: 1, lineCode: 1, slotKey: 1 })
            .lean(),
    ]);
    return buildProductionQcReport({
        plantId: plant.id,
        plantName: plant.name,
        plantCode: plant.code,
        from,
        to,
        filters: resolveFilters(req),
        productionOpening,
        qcOpening,
        lineRecords,
        qcRecords,
        trackingStartDate: (firstTrackedDay as any)?.productionDate,
    });
};

export const getProductionQcReport = async (req: Request, res: Response) => {
    const report = await loadReport(req);
    return sendSuccess(
        res,
        report,
        report.summary.pendingKnown
            ? 'Đã đối soát sản lượng và QC'
            : 'Đã tổng hợp dữ liệu trong kỳ; cần khai báo đầu kỳ để tính lượng còn chờ'
    );
};

export const exportProductionQcReport = async (req: Request, res: Response) => {
    const report = await loadReport(req);
    const workbook = await buildProductionQcReportWorkbook(report);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="production-qc-${report.meta.from}-${report.meta.to}.xlsx"`
    );
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};
