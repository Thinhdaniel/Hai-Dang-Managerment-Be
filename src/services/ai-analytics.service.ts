import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import PurchaseRequest from '@/models/PurchaseRequest';
import Plant from '@/models/Plant';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { buildFacilityCostReport } from '@/services/report.service';
import { runAssistant } from '@/services/ai-agent.service';
import customResponse from '@/utils/response';

// AI Analytics Studio: câu hỏi ngôn ngữ tự nhiên -> chart-spec (chọn TRONG danh mục cho phép,
// chống ảo giác) -> BE chạy aggregation thật -> trả series cho FE vẽ. Không để AI sinh truy vấn thô.

type Dimension = 'plant' | 'status' | 'type' | 'month' | 'repairMode';
type MetricKey =
    | 'asset_count'
    | 'maintenance_count'
    | 'request_count'
    | 'purchase_value'
    | 'distribution_cost'
    | 'external_repair_cost'
    | 'total_cost';
type ChartType = 'bar' | 'line' | 'pie';

const METRICS: Record<MetricKey, { label: string; dims: Dimension[]; unit: string; defaultChart: ChartType; timed: boolean }> = {
    asset_count: { label: 'Số máy', dims: ['plant', 'status', 'type'], unit: 'máy', defaultChart: 'bar', timed: false },
    maintenance_count: { label: 'Số phiếu bảo trì', dims: ['month', 'type', 'repairMode', 'status'], unit: 'phiếu', defaultChart: 'line', timed: true },
    request_count: { label: 'Số phiếu đề xuất mua', dims: ['plant', 'month', 'status'], unit: 'phiếu', defaultChart: 'bar', timed: true },
    purchase_value: { label: 'Giá trị đề xuất mua', dims: ['plant', 'month', 'status'], unit: 'đ', defaultChart: 'bar', timed: true },
    distribution_cost: { label: 'Chi phí cấp phát vật tư', dims: ['plant', 'month'], unit: 'đ', defaultChart: 'bar', timed: true },
    external_repair_cost: { label: 'Chi phí sửa ngoài', dims: ['plant', 'month'], unit: 'đ', defaultChart: 'bar', timed: true },
    total_cost: { label: 'Tổng chi phí vận hành', dims: ['plant', 'month'], unit: 'đ', defaultChart: 'bar', timed: true },
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
    maintenance: 'Bảo trì',
    broken: 'Lỗi/hỏng',
    borrowing: 'Đang mượn',
    storage: 'Tồn kho',
    pending_disposal: 'Chờ thanh lý',
    disposed: 'Đã thanh lý',
    returned_to_partner: 'Đã trả đối tác',
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

    // ----- CHI PHÍ (cấp phát / sửa ngoài / tổng) — tái dùng ĐÚNG công thức report.service -----
    if (metric === 'distribution_cost' || metric === 'external_repair_cost' || metric === 'total_cost') {
        const report = await buildFacilityCostReport({
            groupBy: 'month',
            startDate: monthStart(period - 1),
            endDate: new Date(),
            plantId,
        });
        const pick =
            metric === 'distribution_cost'
                ? 'materialDistributionCost'
                : metric === 'external_repair_cost'
                  ? 'externalRepairCost'
                  : 'totalCost';
        if (dimension === 'month') {
            const rows = [...report.costByPeriod].sort((a, b) => a.period.localeCompare(b.period));
            return {
                categories: rows.map((r) => r.period),
                series: [{ name: meta.label, data: rows.map((r) => Math.round((r as any)[pick] || 0)) }],
                unit,
            };
        }
        const rows = report.costByPlant
            .map((r) => ({ name: r.plantName, value: Math.round((r as any)[pick] || 0) }))
            .filter((r) => r.value > 0)
            .sort((a, b) => b.value - a.value);
        return {
            categories: rows.map((r) => r.name),
            series: [{ name: meta.label, data: rows.map((r) => r.value) }],
            unit,
        };
    }

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

// Định tuyến từ khóa XÁC ĐỊNH (chạy trước AI): câu phân tích/so sánh rõ ràng -> catalog ngay,
// nhanh + luôn đúng + không phụ thuộc AI. Chỉ bắt khi có "tín hiệu phân tích" để không cướp
// các câu liệt kê ("máy nào đang bảo trì") vốn nên đi agentic.
const normQ = (s: string) =>
    s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd');

const keywordSpec = (question: string): Spec | null => {
    const q = normQ(question);
    const has = (...ws: string[]) => ws.some((w) => q.includes(w));
    const analytical = has(
        'theo',
        'so sanh',
        'giua',
        'phan bo',
        'bao nhieu',
        'tong',
        'xu huong',
        'cac co so',
        'moi co so',
        'tung co so',
        'bieu do'
    );
    if (!analytical) return null;

    // Câu "máy/thiết bị/vật tư NÀO ... (nhất)" = xếp hạng theo TỪNG thực thể cụ thể — catalog không có
    // chiều này (chỉ group theo cơ sở/trạng thái/loại). Nhường cho trợ lý agentic (nó liệt kê đúng).
    if (/\bnao\b/.test(q) && has('may', 'thiet bi', 'vat tu', 'nguoi')) return null;

    const isMoney = has('chi phi', 'gia tri', 'tien', 'von', 'tong tien');
    // Ý định hỏi TRẠNG THÁI máy hiện thời ("đang bảo trì/đang hỏng/tồn kho..."): là số máy theo trạng thái,
    // KHÔNG phải số phiếu bảo trì theo thời gian.
    const assetStatusIntent = has(
        'dang bao tri',
        'dang sua',
        'dang hoat dong',
        'dang muon',
        'dang cho',
        'ton kho',
        'cho thanh ly',
        'da thanh ly',
        'bi hong',
        'dang hong',
        'hong hoc'
    );

    let metric: MetricKey | null = null;
    if (assetStatusIntent && has('may', 'thiet bi')) metric = 'asset_count';
    else if (has('cap phat')) metric = 'distribution_cost';
    else if (has('sua ngoai')) metric = 'external_repair_cost';
    else if (has('tong chi phi', 'chi phi van hanh')) metric = 'total_cost';
    else if (has('bao tri')) metric = 'maintenance_count';
    else if (has('de xuat', 'mua sam', 'mua vat tu', 'don mua')) metric = isMoney ? 'purchase_value' : 'request_count';
    else if (has('so may', 'so luong may', 'may theo', 'phan bo may', 'co bao nhieu may', 'bao nhieu may'))
        metric = 'asset_count';
    if (!metric) return null;

    const meta = METRICS[metric];
    const dims = meta.dims;
    // CHỌN CHIỀU theo ý định RÕ RÀNG, ưu tiên đúng. Lưu ý: "6 tháng/X tháng" là KHUNG THỜI GIAN (period),
    // KHÔNG phải yêu cầu nhóm theo tháng -> chỉ chọn month khi có "xu hướng/theo tháng/hàng tháng...".
    const wantsMonth = has('xu huong', 'theo thang', 'hang thang', 'theo ky', 'qua cac thang', 'moi thang', 'theo tung thang', 'theo thoi gian', 'dien bien');
    const wantsStatus = has('trang thai') || assetStatusIntent;
    const wantsType = has('loai may', 'theo loai', 'chung loai');
    const wantsRepair = has('noi bo', 'sua ngoai');
    const wantsPlant = has('co so', 'moi co so', 'tung co so', 'cac co so', 'so sanh', 'giua');
    let dim: Dimension = dims[0];
    if (wantsMonth && dims.includes('month')) dim = 'month';
    else if (wantsStatus && dims.includes('status')) dim = 'status';
    else if (wantsType && dims.includes('type')) dim = 'type';
    else if (wantsRepair && dims.includes('repairMode')) dim = 'repairMode';
    else if (wantsPlant && dims.includes('plant')) dim = 'plant';

    return sanitizeSpec({ metric, dimension: dim, period: 6, title: `${meta.label} theo ${DIM_LABEL[dim]}` });
};

// Lọc biểu đồ (chiều cơ sở) về ĐÚNG các cơ sở được NÊU TÊN trong câu hỏi. Nếu cơ sở được nêu nhưng
// không có số liệu (không xuất hiện trong aggregation) thì zero-fill để vẫn hiện đúng cơ sở đó (=0)
// thay vì hiển thị nhầm sang cơ sở khác. Trả null nếu câu không nêu cơ sở cụ thể nào.
const namedPlantsInQuestion = (question: string, names: string[]): string[] => {
    const nq = normQ(question);
    return names.filter((name) => {
        const core = normQ(name)
            .replace(/^cong ty[^a-z0-9]*/, '')
            .replace(/^c\s*o\s*s\s*o\s*/, '')
            .replace(/^cs\s*/, '')
            .trim();
        if (!core) return false;
        if (/^\d+$/.test(core)) return new RegExp(`(co so|cs)\\s*${core}(?!\\d)`).test(nq); // "cơ sở 1", "cs1"
        return nq.includes(core); // "đại phạm", "kiên trung", "phú sơn"...
    });
};

const filterChartToNamedPlants = (chart: ChartData, matchedNames: string[]): ChartData => {
    const valueByName = new Map(chart.categories.map((c, i) => [c, chart.series[0]?.data[i] ?? 0]));
    return {
        ...chart,
        categories: matchedNames,
        series: chart.series.map((s, si) => ({
            name: s.name,
            data: matchedNames.map((n) => (si === 0 ? (valueByName.get(n) ?? 0) : 0)),
        })),
    };
};

// Map câu hỏi sang catalog. Trả null nếu KHÔNG khớp metric nào (để fallback agentic).
const aiMapSpec = async (question: string): Promise<Spec | null> => {
    const prompt = [
        'Ban map cau hoi nguoi dung sang chart-spec cho he thong quan ly may/vat tu.',
        'CHI chon metric & dimension TRONG danh muc duoi. Khong bia metric/dimension moi.',
        'Neu cau hoi KHONG khop chinh xac metric nao trong danh muc, tra {"metric":"none"}.',
        'QUAN TRONG:',
        '- Cau hoi xep hang theo TUNG may/thiet bi/vat tu cu the ("may nao hong nhieu nhat", "vat tu nao cap nhieu nhat", "top may ...") -> tra {"metric":"none"} (catalog khong co chieu nay).',
        '- Cau hoi so luong may theo trang thai hien thoi ("co bao nhieu may dang bao tri/dang hong/ton kho") -> metric "asset_count", dimension "status".',
        '- "tong chi phi/chi phi van hanh ... theo co so" -> dimension "plant" (KHONG phai month du co cum "X thang").',
        'Danh muc metric (kem cac chieu hop le):',
        catalogForPrompt(),
        'period = so thang gan nhat (mac dinh 6); chartType = bar|line|pie.',
        'Chi tra JSON: {"metric":"...","dimension":"...","period":6,"chartType":"bar","title":"tieu de ngan"} hoac {"metric":"none"}',
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
    const raw = aiResult.data;
    if (!raw?.metric || raw.metric === 'none' || !(METRICS as any)[raw.metric]) return null;
    return sanitizeSpec(raw);
};

// ----- Bảng đối chiếu số (để giám đốc kiểm chứng) -----
const chartToTable = (chart: ChartData) => ({
    columns: ['Hạng mục', chart.series[0]?.name || 'Giá trị'],
    rows: chart.categories.map((c, i) => [c, chart.series[0]?.data[i] ?? 0]),
});

// ----- Converter: aggregates (số THẬT từ tool) -> chart. Số lấy nguyên văn, không bịa. -----
type AgenticChart = { type: ChartType; title: string; categories: string[]; series: { name: string; data: number[] }[]; unit: string };
const num = (v: unknown) => Math.round(Number(v || 0));

const aggregatesToChart = (agg: any): AgenticChart | null => {
    if (!agg || typeof agg !== 'object') return null;
    const mk = (type: ChartType, title: string, categories: any[], name: string, data: number[], unit: string): AgenticChart => ({
        type,
        title,
        categories: categories.map((c) => (c == null || c === '' ? 'Khác' : String(c))), // chống nhãn "null"
        series: [{ name, data }],
        unit,
    });

    // Cơ cấu chi phí (mua / cấp phát / sửa ngoài) -> pie.
    if (agg.costOverview?.purchase) {
        const c = agg.costOverview;
        const v = (b: any) => num(b?.current ?? 0);
        return mk(
            'pie',
            `Cơ cấu chi phí ${c.periodLabel || ''}`.trim(),
            ['Mua vật tư', 'Cấp phát', 'Sửa ngoài'],
            'Chi phí',
            [v(c.purchase), v(c.distribution), v(c.repair)],
            'đ'
        );
    }
    // Mua vs Cấp phát -> bar 2 cột.
    if (agg.compareCost?.purchase) {
        const c = agg.compareCost;
        const v = (b: any) => num(b?.current ?? 0);
        return mk('bar', `Mua vs Cấp phát ${c.periodLabel || ''}`.trim(), ['Mua vật tư', 'Cấp phát'], 'Chi phí', [v(c.purchase), v(c.distribution)], 'đ');
    }
    if (agg.distributionAnalysis?.materials?.length) {
        const ms = agg.distributionAnalysis.materials.slice(0, 12);
        return mk('bar', 'Chi phí cấp phát theo vật tư', ms.map((m: any) => m.materialName), 'Giá trị', ms.map((m: any) => num(m.totalValue)), 'đ');
    }
    if (agg.variance?.drivers?.length) {
        const d = agg.variance.drivers.slice(0, 12);
        return mk(
            'bar',
            agg.variance.metricLabel || 'Yếu tố biến động',
            d.map((x: any) => x.label),
            'Chênh lệch',
            d.map((x: any) => num(x.delta ?? Number(x.current || 0) - Number(x.previous || 0))),
            agg.variance.isCost ? 'đ' : ''
        );
    }
    if (agg.purchaseAnalysis?.rows?.length) {
        const pa = agg.purchaseAnalysis;
        const r = pa.rows.slice(0, 12);
        const title = pa.groupBy === 'supplier' ? 'Chi phí mua theo nhà cung cấp' : 'Chi phí mua theo vật tư';
        return mk(
            'bar',
            title,
            r.map((x: any) => x.label || x.name || x.materialName || x.supplierName || 'Khác'),
            'Kỳ này',
            r.map((x: any) => num(x.current)),
            'đ'
        );
    }
    if (agg.supplierComparison?.suppliers?.length) {
        const s = agg.supplierComparison.suppliers.slice(0, 12);
        return mk('bar', `Giá nhà cung cấp${agg.supplierComparison.materialName ? `: ${agg.supplierComparison.materialName}` : ''}`, s.map((x: any) => x.supplierName), 'Giá', s.map((x: any) => num(x.value)), 'đ');
    }
    if (agg.priceHistory?.points?.length) {
        const p = agg.priceHistory.points;
        return mk(
            'line',
            `Lịch sử giá${agg.priceHistory.materialName ? `: ${agg.priceHistory.materialName}` : ''}`,
            p.map((x: any, i: number) => (x.date ? new Date(x.date).toLocaleDateString('vi-VN', { month: '2-digit', year: '2-digit' }) : String(i + 1))),
            'Đơn giá',
            p.map((x: any) => num(x.unitPrice)),
            'đ'
        );
    }
    if (agg.requestAnalysis?.byPlant?.length) {
        const b = agg.requestAnalysis.byPlant.slice(0, 12);
        const isMoney = b[0]?.value != null;
        return mk('bar', 'Đề xuất theo cơ sở', b.map((x: any) => x.label), isMoney ? 'Giá trị' : 'Số phiếu', b.map((x: any) => num(x.value ?? x.count)), isMoney ? 'đ' : 'phiếu');
    }
    if (agg.requestAnalysis?.byStatus?.length) {
        const b = agg.requestAnalysis.byStatus.slice(0, 10);
        return mk('pie', 'Đề xuất theo trạng thái', b.map((x: any) => x.label), 'Số phiếu', b.map((x: any) => num(x.count)), 'phiếu');
    }
    if (agg.usageByPlant?.materials?.length) {
        const ms = agg.usageByPlant.materials.slice(0, 12);
        return mk('bar', 'Vật tư cấp nhiều nhất', ms.map((m: any) => m.materialName), 'Số lượng', ms.map((m: any) => num(m.totalQty)), '');
    }
    if (agg.topBroken?.length) {
        const t = agg.topBroken.slice(0, 12);
        return mk('bar', 'Máy hỏng nhiều nhất', t.map((x: any) => x.machineCode || x.name), 'Số lần', t.map((x: any) => num(x.count)), 'lần');
    }
    return null;
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

const ok = (res: Response, data: any) =>
    res.status(StatusCodes.OK).json(customResponse({ data, message: 'Đã phân tích', status: StatusCodes.OK, success: true }));

const catalogResult = async (spec: Spec, plantId: string | undefined, aiUsed: boolean, question?: string) => {
    let chart = await buildChart(spec.metric, spec.dimension, spec.period, plantId);
    // Nếu câu hỏi nêu tên cơ sở cụ thể (vd "so sánh ... giữa Đại Phạm và Kiên Trung") -> chỉ giữ
    // đúng các cơ sở đó để khỏi hiển thị nhầm sang cơ sở khác.
    if (spec.dimension === 'plant' && question) {
        const matched = namedPlantsInQuestion(question, [...(await plantNameMap()).values()]);
        if (matched.length) chart = filterChartToNamedPlants(chart, matched);
    }
    const meta = METRICS[spec.metric];
    return {
        source: 'catalog' as const,
        trusted: true,
        spec: { ...spec, metricLabel: meta.label, dimensionLabel: DIM_LABEL[spec.dimension] },
        chart: { type: spec.chartType, title: spec.title, ...chart },
        table: chartToTable(chart),
        narrative: buildNarrative(spec, chart),
        aiUsed,
    };
};

export const runAnalyticsQuery = async (req: Request, res: Response) => {
    const question = String(req.body.question || '').trim();
    const providedSpec = req.body.spec;
    const plantId = req.body.plantId ? String(req.body.plantId) : undefined;

    // 1) Chart đã ghim -> dựng lại trực tiếp theo spec (catalog, số chuẩn).
    if (providedSpec) return ok(res, await catalogResult(sanitizeSpec(providedSpec), plantId, false));

    if (question) {
        // 2a) Định tuyến từ khóa xác định -> catalog ngay (nhanh, không cần AI).
        const kw = keywordSpec(question);
        if (kw) return ok(res, await catalogResult(kw, plantId, false, question));

        // 2b) AI map sang CATALOG (số chuẩn, đúng công thức báo cáo).
        let mapped: Spec | null = null;
        try {
            mapped = await aiMapSpec(question);
        } catch {
            mapped = null;
        }
        if (mapped) return ok(res, await catalogResult(mapped, plantId, true, question));

        // 3) Catalog không phủ -> FALLBACK AGENTIC (tham khảo): số lấy từ tool, kèm bảng đối chiếu.
        try {
            const r = await runAssistant([{ role: 'user', content: question }]);
            const ac = aggregatesToChart(r.aggregates);
            const chart = ac ? { type: ac.type, title: ac.title, categories: ac.categories, series: ac.series, unit: ac.unit } : null;
            const table = ac ? chartToTable({ categories: ac.categories, series: ac.series, unit: ac.unit }) : undefined;
            return ok(res, {
                source: 'agentic',
                trusted: false,
                chart,
                table,
                narrative: r.answer || 'Đã phân tích.',
                aiUsed: true,
            });
        } catch {
            return ok(res, { source: 'agentic', trusted: false, chart: null, narrative: 'Chưa phân tích được câu hỏi này, thử diễn đạt khác.', aiUsed: false });
        }
    }

    // 4) Rỗng -> mặc định an toàn.
    return ok(res, await catalogResult(sanitizeSpec({}), plantId, false));
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
                    'Chi phí cấp phát vật tư theo cơ sở',
                    'So sánh tổng chi phí vận hành giữa các cơ sở',
                    'Chi phí sửa ngoài 6 tháng gần nhất',
                    'Số máy theo cơ sở',
                    'Phân bố máy theo trạng thái',
                    'Giá trị đề xuất mua theo cơ sở',
                    'Số phiếu bảo trì 6 tháng gần nhất',
                ],
            },
            message: 'Danh mục phân tích',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
