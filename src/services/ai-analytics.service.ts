import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import PurchaseRequest from '@/models/PurchaseRequest';
import Plant from '@/models/Plant';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import customResponse from '@/utils/response';

// AI Analytics Studio: câu hỏi ngôn ngữ tự nhiên -> chart-spec (chọn TRONG danh mục cho phép,
// chống ảo giác) -> BE chạy aggregation thật -> trả series cho FE vẽ. Không để AI sinh truy vấn thô.

type Dimension = 'plant' | 'status' | 'type' | 'month' | 'repairMode';
type MetricKey = 'asset_count' | 'maintenance_count' | 'request_count' | 'purchase_value';
type ChartType = 'bar' | 'line' | 'pie';

const METRICS: Record<MetricKey, { label: string; dims: Dimension[]; unit: string; defaultChart: ChartType; timed: boolean }> = {
    asset_count: { label: 'Số máy', dims: ['plant', 'status', 'type'], unit: 'máy', defaultChart: 'bar', timed: false },
    maintenance_count: { label: 'Số phiếu bảo trì', dims: ['month', 'type', 'repairMode', 'status'], unit: 'phiếu', defaultChart: 'line', timed: true },
    request_count: { label: 'Số phiếu đề xuất mua', dims: ['plant', 'month', 'status'], unit: 'phiếu', defaultChart: 'bar', timed: true },
    purchase_value: { label: 'Giá trị đề xuất mua', dims: ['plant', 'month', 'status'], unit: 'đ', defaultChart: 'bar', timed: true },
};

const DIM_LABEL: Record<Dimension, string> = {
    plant: 'cơ sở',
    status: 'trạng thái',
    type: 'loại',
    month: 'tháng',
    repairMode: 'kiểu sửa',
};

const ASSET_STATUS_LABEL: Record<string, string> = {
    active: 'Hoạt động',
    inventory: 'Tồn kho',
    broken: 'Lỗi/hỏng',
    maintenance: 'Bảo trì',
    borrowing: 'Đang mượn',
    pending_disposal: 'Chờ thanh lý',
    disposed: 'Đã thanh lý',
};
const MAINT_TYPE_LABEL: Record<string, string> = { periodic: 'Định kỳ', emergency: 'Sự cố', inspection: 'Kiểm tra' };
const REPAIR_MODE_LABEL: Record<string, string> = { internal: 'Sửa nội bộ', external: 'Sửa ngoài' };
const MAINT_STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ xử lý',
    in_progress: 'Đang xử lý',
    completed: 'Hoàn thành',
    overdue: 'Quá hạn',
    cancelled: 'Đã huỷ',
};
const REQUEST_STATUS_LABEL: Record<string, string> = {
    draft: 'Nháp',
    pending: 'Chờ duyệt',
    approved: 'Đã duyệt',
    rejected: 'Từ chối',
    ordered: 'Đã đặt hàng',
    received: 'Đã nhận',
};

const monthStart = (offset: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - offset, 1);
    d.setHours(0, 0, 0, 0);
    return d;
};

const lastNMonthKeys = (n: number) => {
    const keys: string[] = [];
    for (let i = n - 1; i >= 0; i -= 1) {
        const d = monthStart(i);
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return keys;
};

const plantNameMap = async () => {
    const plants = await Plant.find({ isDeleted: { $ne: true } }).select('_id name code').lean();
    return new Map(plants.map((p: any) => [String(p._id), String(p.name || p.code || 'Chưa rõ')]));
};

type Row = { key: string; value: number };

// Aggregation chung: group theo 1 chiều, trả [{key,value}].
const groupAgg = async (model: any, match: Record<string, any>, groupId: any, valueExpr: any): Promise<Row[]> => {
    const rows = await model.aggregate([{ $match: match }, { $group: { _id: groupId, value: valueExpr } }]);
    return rows.map((r: any) => ({ key: r._id == null ? '' : String(r._id), value: Number(r.value || 0) }));
};

const monthGroupId = (field: string) => ({ $dateToString: { format: '%Y-%m', date: `$${field}` } });

type ChartData = { categories: string[]; series: { name: string; data: number[] }[]; unit: string };

const buildChart = async (metric: MetricKey, dimension: Dimension, period: number, plantId?: string): Promise<ChartData> => {
    const meta = METRICS[metric];
    const unit = meta.unit;
    const plantOid = plantId ? new Types.ObjectId(plantId) : undefined;

    // ----- ASSET_COUNT (không lọc theo thời gian; máy là hiện trạng) -----
    if (metric === 'asset_count') {
        const match: Record<string, any> = { isDeleted: { $ne: true } };
        if (plantOid) match.plantId = plantOid;
        if (dimension === 'plant') {
            const names = await plantNameMap();
            const rows = await groupAgg(Asset, match, '$plantId', { $sum: 1 });
            const sorted = rows.sort((a, b) => b.value - a.value);
            return {
                categories: sorted.map((r) => names.get(r.key) || 'Chưa gán'),
                series: [{ name: meta.label, data: sorted.map((r) => r.value) }],
                unit,
            };
        }
        const field = dimension === 'status' ? '$status' : '$type';
        const labelMap = dimension === 'status' ? ASSET_STATUS_LABEL : undefined;
        const rows = (await groupAgg(Asset, match, field, { $sum: 1 })).sort((a, b) => b.value - a.value).slice(0, 15);
        return {
            categories: rows.map((r) => labelMap?.[r.key] || r.key || 'Khác'),
            series: [{ name: meta.label, data: rows.map((r) => r.value) }],
            unit,
        };
    }

    // ----- MAINTENANCE_COUNT -----
    if (metric === 'maintenance_count') {
        const match: Record<string, any> = { isDeleted: { $ne: true } };
        if (meta.timed) match.startDate = { $gte: monthStart(period - 1) };
        if (dimension === 'month') {
            const rows = await groupAgg(Maintenance, match, monthGroupId('startDate'), { $sum: 1 });
            const byKey = new Map(rows.map((r) => [r.key, r.value]));
            const keys = lastNMonthKeys(period);
            return {
                categories: keys.map((k) => k.slice(5) + '/' + k.slice(0, 4)),
                series: [{ name: meta.label, data: keys.map((k) => byKey.get(k) || 0) }],
                unit,
            };
        }
        const field = dimension === 'type' ? '$type' : dimension === 'repairMode' ? '$repairMode' : '$status';
        const labelMap =
            dimension === 'type' ? MAINT_TYPE_LABEL : dimension === 'repairMode' ? REPAIR_MODE_LABEL : MAINT_STATUS_LABEL;
        const rows = (await groupAgg(Maintenance, match, field, { $sum: 1 })).sort((a, b) => b.value - a.value);
        return {
            categories: rows.map((r) => labelMap[r.key] || r.key || 'Khác'),
            series: [{ name: meta.label, data: rows.map((r) => r.value) }],
            unit,
        };
    }

    // ----- REQUEST_COUNT / PURCHASE_VALUE (PurchaseRequest, requestType=purchase) -----
    const isValue = metric === 'purchase_value';
    const valueExpr = isValue ? { $sum: { $ifNull: ['$totalWithVat', 0] } } : { $sum: 1 };
    const match: Record<string, any> = { isDeleted: { $ne: true }, requestType: 'purchase' };
    if (meta.timed && dimension === 'month') match.createdAt = { $gte: monthStart(period - 1) };
    else if (meta.timed) match.createdAt = { $gte: monthStart(period - 1) };
    if (plantOid) match.plantId = plantOid;

    if (dimension === 'plant') {
        const names = await plantNameMap();
        const rows = (await groupAgg(PurchaseRequest, match, '$plantId', valueExpr)).sort((a, b) => b.value - a.value);
        return {
            categories: rows.map((r) => names.get(r.key) || 'Chưa rõ'),
            series: [{ name: meta.label, data: rows.map((r) => Math.round(r.value)) }],
            unit,
        };
    }
    if (dimension === 'month') {
        const rows = await groupAgg(PurchaseRequest, match, monthGroupId('createdAt'), valueExpr);
        const byKey = new Map(rows.map((r) => [r.key, r.value]));
        const keys = lastNMonthKeys(period);
        return {
            categories: keys.map((k) => k.slice(5) + '/' + k.slice(0, 4)),
            series: [{ name: meta.label, data: keys.map((k) => Math.round(byKey.get(k) || 0)) }],
            unit,
        };
    }
    // status
    const rows = (await groupAgg(PurchaseRequest, match, '$status', valueExpr)).sort((a, b) => b.value - a.value);
    return {
        categories: rows.map((r) => REQUEST_STATUS_LABEL[r.key] || r.key || 'Khác'),
        series: [{ name: meta.label, data: rows.map((r) => Math.round(r.value)) }],
        unit,
    };
};

const catalogForPrompt = () =>
    Object.entries(METRICS)
        .map(([key, m]) => `- ${key} (${m.label}); chiều: ${m.dims.join(', ')}`)
        .join('\n');

type Spec = { metric: MetricKey; dimension: Dimension; period: number; chartType: ChartType; title: string };

const sanitizeSpec = (raw: any): Spec => {
    const metric: MetricKey = (METRICS as any)[raw?.metric] ? raw.metric : 'asset_count';
    const meta = METRICS[metric];
    const dimension: Dimension = meta.dims.includes(raw?.dimension) ? raw.dimension : meta.dims[0];
    let period = Number(raw?.period);
    if (!Number.isFinite(period) || period < 1) period = 6;
    period = Math.min(Math.round(period), 24);
    const chartType: ChartType = ['bar', 'line', 'pie'].includes(raw?.chartType)
        ? raw.chartType
        : dimension === 'month'
          ? 'line'
          : dimension === 'status'
            ? 'pie'
            : 'bar';
    const title = String(raw?.title || `${meta.label} theo ${DIM_LABEL[dimension]}`).slice(0, 120);
    return { metric, dimension, period, chartType, title };
};

const aiSpecFromQuestion = async (question: string): Promise<Spec> => {
    const prompt = [
        'Ban map cau hoi cua nguoi dung sang chart-spec cho he thong quan ly may/vat tu.',
        'CHI chon metric & dimension TRONG danh muc duoi. Khong bia metric/dimension moi.',
        'Danh muc metric (kem cac chieu hop le):',
        catalogForPrompt(),
        'period = so thang gan nhat (mac dinh 6) cho metric co thoi gian; chartType = bar|line|pie.',
        'Chi tra JSON: {"metric":"...","dimension":"...","period":6,"chartType":"bar","title":"tieu de tieng Viet ngan"}',
        `Cau hoi: ${question}`,
    ].join('\n');
    const aiResult = await aiProviderService.generateJson<any>({
        feature: 'analytics',
        temperature: 0.05,
        maxTokens: 300,
        messages: [
            { role: 'system', content: 'Ban tra ve DUY NHAT JSON chart-spec hop le, khong giai thich.' },
            { role: 'user', content: prompt },
        ],
    });
    return sanitizeSpec(aiResult.data);
};

const fmtNum = (v: number, unit: string) => (unit === 'đ' ? `${Math.round(v).toLocaleString('vi-VN')}đ` : `${v.toLocaleString('vi-VN')} ${unit}`);

const buildNarrative = (spec: Spec, chart: ChartData): string => {
    const total = chart.series[0]?.data.reduce((s, n) => s + n, 0) ?? 0;
    if (!chart.categories.length) return 'Chưa có dữ liệu phù hợp cho câu hỏi này.';
    let maxIdx = 0;
    chart.series[0]?.data.forEach((n, i) => {
        if (n > (chart.series[0]?.data[maxIdx] ?? 0)) maxIdx = i;
    });
    const top = chart.categories[maxIdx];
    const topVal = chart.series[0]?.data[maxIdx] ?? 0;
    return `Tổng ${fmtNum(total, chart.unit)} qua ${chart.categories.length} ${DIM_LABEL[spec.dimension]}. Cao nhất: ${top} (${fmtNum(topVal, chart.unit)}).`;
};

export const runAnalyticsQuery = async (req: Request, res: Response) => {
    const question = String(req.body.question || '').trim();
    const providedSpec = req.body.spec;
    const plantId = req.body.plantId ? String(req.body.plantId) : undefined;

    let spec: Spec;
    let aiUsed = false;
    if (providedSpec) {
        spec = sanitizeSpec(providedSpec); // chart đã ghim -> không cần AI, dựng lại nhanh
    } else if (question) {
        try {
            spec = await aiSpecFromQuestion(question);
            aiUsed = true;
        } catch {
            spec = sanitizeSpec({}); // AI lỗi -> mặc định an toàn (số máy theo cơ sở)
        }
    } else {
        spec = sanitizeSpec({});
    }

    const chart = await buildChart(spec.metric, spec.dimension, spec.period, plantId);
    const meta = METRICS[spec.metric];

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                spec: { ...spec, metricLabel: meta.label, dimensionLabel: DIM_LABEL[spec.dimension] },
                chart: { type: spec.chartType, title: spec.title, ...chart },
                narrative: buildNarrative(spec, chart),
                aiUsed,
            },
            message: 'Đã phân tích',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// Danh mục để FE gợi ý câu hỏi mẫu / nhãn.
export const getAnalyticsCatalog = async (_req: Request, res: Response) => {
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                metrics: Object.entries(METRICS).map(([key, m]) => ({
                    key,
                    label: m.label,
                    unit: m.unit,
                    dimensions: m.dims.map((d) => ({ key: d, label: DIM_LABEL[d] })),
                })),
                samples: [
                    'Số máy theo cơ sở',
                    'Phân bố máy theo trạng thái',
                    'Số phiếu bảo trì 6 tháng gần nhất',
                    'Bảo trì nội bộ so với sửa ngoài',
                    'Giá trị đề xuất mua theo cơ sở',
                    'Đề xuất mua theo trạng thái',
                ],
            },
            message: 'Danh mục phân tích',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
