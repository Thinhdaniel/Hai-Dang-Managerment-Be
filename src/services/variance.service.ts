import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { endOfMonth, endOfWeek, format, startOfMonth, startOfWeek, subMonths, subWeeks } from 'date-fns';
import Maintenance from '@/models/Maintenance';
import DistributionRecord from '@/models/DistributionRecord';
import PurchaseOrder from '@/models/PurchaseOrder';
import Plant from '@/models/Plant';
import customResponse from '@/utils/response';

type Metric = 'repair_cost' | 'distribution_cost' | 'purchase_cost' | 'total_cost' | 'maintenance_tickets';
type PeriodType = 'week' | 'month';

const METRIC_LABEL: Record<Metric, string> = {
    repair_cost: 'Chi phí sửa ngoài',
    distribution_cost: 'Chi phí cấp phát vật tư',
    purchase_cost: 'Chi phí mua vật tư',
    total_cost: 'Tổng chi phí',
    maintenance_tickets: 'Số phiếu bảo trì',
};
const VALID_METRICS = new Set<Metric>(['repair_cost', 'distribution_cost', 'purchase_cost', 'total_cost', 'maintenance_tickets']);

const periodRange = (type: PeriodType) => {
    const now = new Date();
    if (type === 'week') {
        return {
            start: startOfWeek(now, { weekStartsOn: 1 }),
            end: endOfWeek(now, { weekStartsOn: 1 }),
            prevStart: startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }),
            prevEnd: endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }),
            label: 'tuần này',
            prevLabel: 'tuần trước',
        };
    }
    return {
        start: startOfMonth(now),
        end: endOfMonth(now),
        prevStart: startOfMonth(subMonths(now, 1)),
        prevEnd: endOfMonth(subMonths(now, 1)),
        label: `tháng ${format(now, 'MM/yyyy')}`,
        prevLabel: `tháng ${format(subMonths(now, 1), 'MM/yyyy')}`,
    };
};

const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0);
const vnd = (v: number) => `${Math.round(v).toLocaleString('vi-VN')}đ`;

const REPAIR_VALUE = { $sum: { $ifNull: ['$cost', 0] } };
const DIST_VALUE = { $sum: { $ifNull: ['$totalWithVat', { $ifNull: ['$totalAmount', 0] }] } };
const COUNT_VALUE = { $sum: 1 };

const groupByPlant = async (model: any, match: Record<string, any>, valueExpr: any, plantField: string) => {
    const rows = await model.aggregate([{ $match: match }, { $group: { _id: `$${plantField}`, v: valueExpr } }]);
    return new Map<string, number>(rows.map((r: any) => [String(r._id), Number(r.v) || 0]));
};

const mergeAdd = (a: Map<string, number>, b: Map<string, number>) => {
    const out = new Map(a);
    for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
    return out;
};

// Cấp phát vật tư: KHỚP công thức báo cáo chi phí cơ sở (report.service) để AI không lệch số liệu:
//  - Giá trị = tổng các dòng items (totalWithVat/totalPrice), fallback tổng ở cấp phiếu.
//  - Ngày hiệu lực = distributedAt || confirmedAt || createdAt (KHÔNG chỉ dùng createdAt).
//  - Gom theo cơ sở nhận (toPlantId — gồm cả cấp phát nội bộ vì to=from).
const groupDistByPlant = async (s: Date, e: Date) => {
    const rows = await DistributionRecord.aggregate([
        {
            $addFields: {
                _eff: { $ifNull: ['$distributedAt', { $ifNull: ['$confirmedAt', '$createdAt'] }] },
                _items: {
                    $sum: {
                        $map: {
                            input: { $ifNull: ['$items', []] },
                            as: 'it',
                            in: { $ifNull: ['$$it.totalWithVat', { $ifNull: ['$$it.totalPrice', 0] }] },
                        },
                    },
                },
            },
        },
        { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] }, _eff: { $gte: s, $lte: e } } },
        {
            $group: {
                _id: '$toPlantId',
                v: { $sum: { $cond: [{ $gt: ['$_items', 0] }, '$_items', { $ifNull: ['$totalWithVat', { $ifNull: ['$totalAmount', 0] }] }] } },
            },
        },
    ]);
    return new Map<string, number>(rows.map((r: any) => [String(r._id), Number(r.v) || 0]));
};

// Lấy 2 map (kỳ này / kỳ trước) theo cơ sở cho từng chỉ số.
const buildMaps = async (metric: Metric, r: ReturnType<typeof periodRange>) => {
    const repairMatch = (s: Date, e: Date) => ({
        isDeleted: { $ne: true },
        repairMode: 'external',
        status: 'completed',
        endDate: { $gte: s, $lte: e },
    });
    const ticketMatch = (s: Date, e: Date) => ({ isDeleted: { $ne: true }, createdAt: { $gte: s, $lte: e } });
    const purchaseMatch = (s: Date, e: Date) => ({
        isDeleted: { $ne: true },
        status: { $in: ['ordered', 'partially_received', 'received'] },
        createdAt: { $gte: s, $lte: e },
    });

    if (metric === 'purchase_cost') {
        return {
            cur: await groupByPlant(PurchaseOrder, purchaseMatch(r.start, r.end), DIST_VALUE, 'plantId'),
            prev: await groupByPlant(PurchaseOrder, purchaseMatch(r.prevStart, r.prevEnd), DIST_VALUE, 'plantId'),
        };
    }
    if (metric === 'repair_cost') {
        return {
            cur: await groupByPlant(Maintenance, repairMatch(r.start, r.end), REPAIR_VALUE, 'plantId'),
            prev: await groupByPlant(Maintenance, repairMatch(r.prevStart, r.prevEnd), REPAIR_VALUE, 'plantId'),
        };
    }
    if (metric === 'distribution_cost') {
        return {
            cur: await groupDistByPlant(r.start, r.end),
            prev: await groupDistByPlant(r.prevStart, r.prevEnd),
        };
    }
    if (metric === 'maintenance_tickets') {
        return {
            cur: await groupByPlant(Maintenance, ticketMatch(r.start, r.end), COUNT_VALUE, 'plantId'),
            prev: await groupByPlant(Maintenance, ticketMatch(r.prevStart, r.prevEnd), COUNT_VALUE, 'plantId'),
        };
    }
    // total_cost = sửa ngoài + cấp phát
    const [rcCur, dcCur, rcPrev, dcPrev] = await Promise.all([
        groupByPlant(Maintenance, repairMatch(r.start, r.end), REPAIR_VALUE, 'plantId'),
        groupDistByPlant(r.start, r.end),
        groupByPlant(Maintenance, repairMatch(r.prevStart, r.prevEnd), REPAIR_VALUE, 'plantId'),
        groupDistByPlant(r.prevStart, r.prevEnd),
    ]);
    return { cur: mergeAdd(rcCur, dcCur), prev: mergeAdd(rcPrev, dcPrev) };
};

export const computeVarianceData = async (metricInput: unknown, periodInput: unknown) => {
    const metric = (VALID_METRICS.has(metricInput as Metric) ? metricInput : 'total_cost') as Metric;
    const periodType = (String(periodInput) === 'week' ? 'week' : 'month') as PeriodType;
    const isCost = metric !== 'maintenance_tickets';
    const r = periodRange(periodType);

    const { cur, prev } = await buildMaps(metric, r);
    const current = [...cur.values()].reduce((s, v) => s + v, 0);
    const previous = [...prev.values()].reduce((s, v) => s + v, 0);
    const totalDelta = current - previous;

    // Tên cơ sở
    const plants = await Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean();
    const plantName = new Map(plants.map((p: any) => [String(p._id), String(p.name)]));

    const drivers = [...new Set([...cur.keys(), ...prev.keys()])]
        .map((id) => {
            const c = cur.get(id) ?? 0;
            const p = prev.get(id) ?? 0;
            return {
                label: plantName.get(id) || 'Chưa gán cơ sở',
                current: c,
                previous: p,
                delta: c - p,
                contributionPct: totalDelta !== 0 ? Math.round(((c - p) / totalDelta) * 100) : 0,
            };
        })
        .filter((d) => d.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 6);

    const deltaPct = pct(current, previous);
    const fmt = (v: number) => (isCost ? vnd(v) : `${v}`);
    const fallback =
        `${METRIC_LABEL[metric]} ${r.label}: ${fmt(current)} (${deltaPct >= 0 ? '+' : ''}${deltaPct}% so ${r.prevLabel}). ` +
        (drivers[0]
            ? `Biến động chủ yếu ở ${drivers[0].label} (${drivers[0].delta >= 0 ? '+' : ''}${fmt(drivers[0].delta)}).`
            : 'Không có thay đổi đáng kể theo cơ sở.');

    // Câu giải thích DỰNG TỪ SỐ LIỆU THẬT (không để AI bịa số). Số liệu luôn đúng tuyệt đối.
    const explanation = fallback;

    return {
        metric,
        metricLabel: METRIC_LABEL[metric],
        periodType,
        isCost,
        current,
        previous,
        deltaPct,
        drivers,
        explanation,
        provider: 'computed',
    };
};

export const explainVariance = async (req: Request, res: Response) => {
    const data = await computeVarianceData(req.body.metric, req.body.periodType);
    return res.status(StatusCodes.OK).json(
        customResponse({ data, message: 'Da phan tich bien dong', status: StatusCodes.OK, success: true })
    );
};
