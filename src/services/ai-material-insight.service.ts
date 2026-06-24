import { endOfMonth, endOfWeek, format, startOfMonth, startOfWeek, subDays, subMonths, subWeeks } from 'date-fns';
import DistributionRecord from '@/models/DistributionRecord';
import PurchaseOrder from '@/models/PurchaseOrder';
import Plant from '@/models/Plant';
import Material from '@/models/Material';
import InventoryStock from '@/models/InventoryStock';

// ===== Tiện ích dùng chung =====
type PeriodType = 'week' | 'month';

const normalize = (v?: string) =>
    (v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

export const vnd = (v: number) => `${Math.round(v || 0).toLocaleString('vi-VN')}đ`;

const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0);

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

// Map id->tên cơ sở, và resolve tên->id (khớp bỏ dấu, tuyệt đối hoặc chứa nhau).
const loadPlants = async () => {
    const plants = await Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean();
    const nameById = new Map(plants.map((p: any) => [String(p._id), String(p.name)]));
    const resolve = (input?: string): string | undefined => {
        if (!input) return undefined;
        const q = normalize(input);
        const hit =
            plants.find((p: any) => normalize(p.name) === q) ||
            plants.find((p: any) => normalize(p.name).includes(q) || q.includes(normalize(p.name)));
        return hit ? String((hit as any)._id) : undefined;
    };
    return { nameById, resolve };
};

const DIST_VALUE = { $ifNull: ['$items.totalWithVat', { $ifNull: ['$items.totalPrice', 0] }] };
const DIST_QTY = { $ifNull: ['$items.quantityDistributed', '$items.quantity'] };
// Ngày hiệu lực của phiếu cấp phát — khớp report.service (distributedAt > confirmedAt > createdAt).
const DIST_EFF = { $ifNull: ['$distributedAt', { $ifNull: ['$confirmedAt', '$createdAt'] }] };
const PO_VALUE = { $ifNull: ['$items.totalWithVat', { $ifNull: ['$items.totalPrice', 0] }] };

// ============================================================
// 1) Vật tư cấp phát nhiều nhất, phân rã theo cơ sở nhận
// ============================================================
export const materialUsageByPlant = async (args: {
    plantName?: string;
    materialName?: string;
    period?: string;
    limit?: number;
}) => {
    const { nameById, resolve } = await loadPlants();
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
    const plantId = resolve(args.plantName);

    let periodLabel = 'toàn bộ thời gian';
    let periodFilter: { $gte: Date; $lte: Date } | null = null;
    if (args.period === 'week' || args.period === 'month') {
        const r = periodRange(args.period);
        periodFilter = { $gte: r.start, $lte: r.end };
        periodLabel = r.label;
    }

    // Lọc theo cơ sở (toPlantId) thực hiện sau khi gom, để giữ đúng phân rã từng cơ sở.
    const pipeline: any[] = [
        { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] } } },
        // Lọc kỳ theo ngày hiệu lực (distributedAt||confirmedAt||createdAt) cho khớp báo cáo.
        ...(periodFilter ? [{ $addFields: { _eff: DIST_EFF } }, { $match: { _eff: periodFilter } }] : []),
        { $unwind: '$items' },
        { $match: { 'items.materialId': { $ne: null } } },
        {
            $group: {
                _id: { material: '$items.materialId', plant: '$toPlantId' },
                materialName: { $first: '$items.materialName' },
                unit: { $first: '$items.unit' },
                qty: { $sum: DIST_QTY },
                value: { $sum: DIST_VALUE },
            },
        },
        {
            $group: {
                _id: '$_id.material',
                materialName: { $first: '$materialName' },
                unit: { $first: '$unit' },
                totalQty: { $sum: '$qty' },
                totalValue: { $sum: '$value' },
                plants: { $push: { plantId: '$_id.plant', qty: '$qty', value: '$value' } },
            },
        },
        { $sort: { totalValue: -1, totalQty: -1 } },
        { $limit: limit },
        // Bổ sung tên/đơn vị từ bảng materials cho bản ghi cũ thiếu materialName.
        { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'm' } },
        { $unwind: { path: '$m', preserveNullAndEmptyArrays: true } },
    ];

    let rows = await DistributionRecord.aggregate(pipeline);

    // Lọc theo cơ sở (nếu có): chỉ giữ phần cấp phát về đúng cơ sở đó.
    if (plantId) {
        rows = rows
            .map((r: any) => {
                const plants = (r.plants || []).filter((p: any) => String(p.plantId) === plantId);
                const totalQty = plants.reduce((s: number, p: any) => s + (p.qty || 0), 0);
                const totalValue = plants.reduce((s: number, p: any) => s + (p.value || 0), 0);
                return { ...r, plants, totalQty, totalValue };
            })
            .filter((r: any) => r.totalValue > 0 || r.totalQty > 0)
            .sort((a: any, b: any) => b.totalValue - a.totalValue)
            .slice(0, limit);
    }

    const materials = rows.map((r: any) => ({
        materialName: r.materialName || r.m?.name || 'Vật tư',
        unit: r.unit || r.m?.unit || '',
        totalQty: Math.round(r.totalQty || 0),
        totalValue: Math.round(r.totalValue || 0),
        plants: (r.plants || [])
            .map((p: any) => ({ plantName: nameById.get(String(p.plantId)) || 'Chưa gán cơ sở', qty: Math.round(p.qty || 0), value: Math.round(p.value || 0) }))
            .sort((a: any, b: any) => b.value - a.value),
    }));

    const totalValue = materials.reduce((s, m) => s + m.totalValue, 0);
    const totalQty = materials.reduce((s, m) => s + m.totalQty, 0);

    return {
        periodLabel,
        plantName: plantId ? nameById.get(plantId) : undefined,
        totalValue,
        totalQty,
        materials,
    };
};

// ============================================================
// 2) Phân tích chi tiết chi phí MUA vật tư: kỳ này vs kỳ trước,
//    phân rã theo vật tư hoặc nhà cung cấp.
// ============================================================
export const analyzePurchases = async (args: { period?: string; groupBy?: string; limit?: number }) => {
    const periodType: PeriodType = args.period === 'week' ? 'week' : 'month';
    const groupBy = args.groupBy === 'supplier' ? 'supplier' : 'material';
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
    const r = periodRange(periodType);

    const baseMatch = (s: Date, e: Date) => ({
        isDeleted: { $ne: true },
        status: { $in: ['ordered', 'partially_received', 'received'] },
        createdAt: { $gte: s, $lte: e },
    });

    const keyField = groupBy === 'supplier' ? '$items.supplierName' : '$items.materialName';

    const aggOne = async (s: Date, e: Date) => {
        const rows = await PurchaseOrder.aggregate([
            { $match: baseMatch(s, e) },
            { $unwind: '$items' },
            {
                $group: {
                    _id: { $ifNull: [keyField, groupBy === 'supplier' ? 'Chưa rõ NCC' : 'Chưa rõ vật tư'] },
                    value: { $sum: PO_VALUE },
                    qty: { $sum: { $ifNull: ['$items.quantityOrdered', 0] } },
                    unit: { $first: '$items.unit' },
                },
            },
        ]);
        const map = new Map<string, { value: number; qty: number; unit: string }>();
        let total = 0;
        for (const row of rows) {
            map.set(String(row._id), { value: row.value || 0, qty: row.qty || 0, unit: row.unit || '' });
            total += row.value || 0;
        }
        return { map, total };
    };

    const [cur, prev] = await Promise.all([aggOne(r.start, r.end), aggOne(r.prevStart, r.prevEnd)]);
    const totalDelta = cur.total - prev.total;

    const rows = [...new Set([...cur.map.keys(), ...prev.map.keys()])]
        .map((label) => {
            const c = cur.map.get(label)?.value ?? 0;
            const p = prev.map.get(label)?.value ?? 0;
            return {
                label,
                unit: cur.map.get(label)?.unit || prev.map.get(label)?.unit || '',
                current: Math.round(c),
                previous: Math.round(p),
                qty: Math.round(cur.map.get(label)?.qty ?? 0),
                delta: Math.round(c - p),
                contributionPct: totalDelta !== 0 ? Math.round(((c - p) / totalDelta) * 100) : 0,
            };
        })
        .filter((d) => d.current !== 0 || d.previous !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current)
        .slice(0, limit);

    return {
        periodType,
        periodLabel: r.label,
        prevLabel: r.prevLabel,
        groupBy,
        current: Math.round(cur.total),
        previous: Math.round(prev.total),
        deltaPct: pct(cur.total, prev.total),
        rows,
    };
};

// ============================================================
// 3) Danh sách / chi tiết đơn hàng mua vật tư
// ============================================================
const PO_STATUS_LABEL: Record<string, string> = {
    draft: 'Nháp',
    confirmed: 'Đã duyệt',
    ordered: 'Đã đặt',
    partially_received: 'Nhận một phần',
    received: 'Đã nhận',
    cancelled: 'Đã huỷ',
};

export const listPurchaseOrders = async (args: {
    search?: string;
    orderCode?: string;
    supplierName?: string;
    plantName?: string;
    status?: string;
    period?: string;
    limit?: number;
}) => {
    const { nameById, resolve } = await loadPlants();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    const rx = (v: string) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const code = args.orderCode || args.search;
    const wantDetail = Boolean(args.orderCode) || Boolean(args.search && /^[A-Za-z0-9._/-]+$/.test(String(args.search).trim()) && String(args.search).trim().length >= 4);

    if (code) {
        filter.$or = [
            { orderCode: rx(String(code)) },
            { supplierName: rx(String(code)) },
            { 'items.materialName': rx(String(code)) },
            { 'items.supplierName': rx(String(code)) },
        ];
    }
    if (args.supplierName) filter.supplierName = rx(String(args.supplierName));
    if (args.status && PO_STATUS_LABEL[args.status]) filter.status = args.status;
    const plantId = resolve(args.plantName);
    if (plantId) filter.plantId = plantId;
    if (args.period === 'week' || args.period === 'month') {
        const r = periodRange(args.period);
        filter.createdAt = { $gte: r.start, $lte: r.end };
    }

    const count = await PurchaseOrder.countDocuments(filter);
    const docs = await PurchaseOrder.find(filter).sort({ createdAt: -1 }).limit(limit).lean();

    const detail = wantDetail && docs.length <= 3;

    const orders = docs.map((o: any) => {
        const base = {
            orderCode: o.orderCode || '(chưa có mã)',
            supplierName: o.supplierName || (o.items?.[0]?.supplierName ?? 'Chưa rõ NCC'),
            plantName: nameById.get(String(o.plantId)) || o.items?.[0]?.plantName || undefined,
            status: o.status,
            statusLabel: PO_STATUS_LABEL[o.status] || o.status,
            totalWithVat: Math.round(o.totalWithVat || o.totalAmount || 0),
            itemCount: o.items?.length || 0,
            createdAt: o.createdAt,
        };
        if (!detail) return base;
        return {
            ...base,
            items: (o.items || []).map((it: any) => ({
                materialName: it.materialName || 'Vật tư',
                unit: it.unit || '',
                quantityOrdered: Math.round(it.quantityOrdered || 0),
                quantityReceived: Math.round(it.quantityReceived || 0),
                unitPrice: Math.round(it.unitPrice || 0),
                totalWithVat: Math.round(it.totalWithVat || it.totalPrice || 0),
                supplierName: it.supplierName || undefined,
            })),
        };
    });

    return { count, detail, orders };
};

const rxOf = (v: string) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// ============================================================
// 4) Lịch sử & xu hướng GIÁ MUA của 1 vật tư (theo từng đơn)
// ============================================================
export const materialPriceHistory = async (args: { materialName?: string; limit?: number }) => {
    const q = (args.materialName || '').trim();
    if (!q) return { materialName: '', count: 0, points: [], minPrice: 0, maxPrice: 0, avgPrice: 0, trendPct: 0 };
    const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 30);

    const rows = await PurchaseOrder.aggregate([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['ordered', 'partially_received', 'received'] } } },
        { $unwind: '$items' },
        { $match: { 'items.materialName': rxOf(q) } },
        {
            $project: {
                orderCode: 1,
                createdAt: 1,
                supplierName: { $ifNull: ['$items.supplierName', '$supplierName'] },
                unit: '$items.unit',
                materialName: '$items.materialName',
                qty: { $ifNull: ['$items.quantityOrdered', 0] },
                unitPrice: { $ifNull: ['$items.unitPrice', 0] },
                totalWithVat: PO_VALUE,
            },
        },
        { $sort: { createdAt: 1 } },
    ]);

    const points = rows.map((r: any) => ({
        orderCode: r.orderCode || '(chưa có mã)',
        date: r.createdAt,
        supplierName: String(r.supplierName || '').trim() || 'Chưa rõ NCC',
        unit: r.unit || '',
        qty: Math.round(r.qty || 0),
        unitPrice: Math.round(r.unitPrice || 0),
        totalWithVat: Math.round(r.totalWithVat || 0),
    }));
    const prices = points.map((p) => p.unitPrice).filter((v) => v > 0);
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    const avgPrice = prices.length ? Math.round(prices.reduce((s, v) => s + v, 0) / prices.length) : 0;
    const trendPct = prices.length >= 2 && prices[0] > 0 ? Math.round(((prices[prices.length - 1] - prices[0]) / prices[0]) * 100) : 0;

    return {
        materialName: rows[0]?.materialName || q,
        unit: points[0]?.unit || '',
        count: points.length,
        points: points.slice(-limit),
        minPrice,
        maxPrice,
        avgPrice,
        trendPct,
    };
};

// ============================================================
// 5) So sánh GIÁ giữa các NHÀ CUNG CẤP cho 1 vật tư (mua đâu rẻ)
// ============================================================
export const supplierComparison = async (args: { materialName?: string; limit?: number }) => {
    const q = (args.materialName || '').trim();
    if (!q) return { materialName: '', suppliers: [] };
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15);

    const rows = await PurchaseOrder.aggregate([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['ordered', 'partially_received', 'received'] } } },
        { $unwind: '$items' },
        { $match: { 'items.materialName': rxOf(q), 'items.unitPrice': { $gt: 0 } } },
        {
            $group: {
                _id: { $ifNull: ['$items.supplierName', { $ifNull: ['$supplierName', 'Chưa rõ NCC'] }] },
                avgPrice: { $avg: '$items.unitPrice' },
                minPrice: { $min: '$items.unitPrice' },
                maxPrice: { $max: '$items.unitPrice' },
                qty: { $sum: { $ifNull: ['$items.quantityOrdered', 0] } },
                value: { $sum: PO_VALUE },
                orders: { $sum: 1 },
                unit: { $first: '$items.unit' },
            },
        },
        { $sort: { avgPrice: 1 } },
        { $limit: limit },
    ]);

    const suppliers = rows.map((r: any) => ({
        supplierName: String(r._id).trim() || 'Chưa rõ NCC',
        avgPrice: Math.round(r.avgPrice || 0),
        minPrice: Math.round(r.minPrice || 0),
        maxPrice: Math.round(r.maxPrice || 0),
        qty: Math.round(r.qty || 0),
        value: Math.round(r.value || 0),
        orders: r.orders || 0,
        unit: r.unit || '',
    }));
    return { materialName: q, unit: suppliers[0]?.unit || '', cheapest: suppliers[0]?.supplierName, suppliers };
};

// ============================================================
// 6) Phân tích CẤP PHÁT chi tiết + THIẾU HỤT (shortage)
// ============================================================
export const distributionAnalysis = async (args: { plantName?: string; period?: string; limit?: number }) => {
    const { nameById, resolve } = await loadPlants();
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
    const plantId = resolve(args.plantName);

    const match: Record<string, any> = { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] } };
    let periodLabel = 'toàn bộ thời gian';
    let periodFilter: { $gte: Date; $lte: Date } | null = null;
    if (args.period === 'week' || args.period === 'month') {
        const r = periodRange(args.period);
        periodFilter = { $gte: r.start, $lte: r.end };
        periodLabel = r.label;
    }
    if (plantId) match.toPlantId = plantId;

    const rows = await DistributionRecord.aggregate([
        { $match: match },
        // Lọc kỳ theo ngày hiệu lực (distributedAt||confirmedAt||createdAt) cho khớp báo cáo.
        ...(periodFilter ? [{ $addFields: { _eff: DIST_EFF } }, { $match: { _eff: periodFilter } }] : []),
        { $unwind: '$items' },
        {
            $group: {
                _id: '$items.materialName',
                qty: { $sum: DIST_QTY },
                value: { $sum: DIST_VALUE },
                shortageQty: { $sum: { $ifNull: ['$items.quantityShortage', 0] } },
                shortageLines: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$items.quantityShortage', 0] }, 0] }, 1, 0] } },
                unit: { $first: '$items.unit' },
            },
        },
        { $sort: { value: -1 } },
    ]);

    const totalValue = rows.reduce((s: number, r: any) => s + (r.value || 0), 0);
    const totalQty = rows.reduce((s: number, r: any) => s + (r.qty || 0), 0);
    const totalShortageQty = rows.reduce((s: number, r: any) => s + (r.shortageQty || 0), 0);
    const totalShortageLines = rows.reduce((s: number, r: any) => s + (r.shortageLines || 0), 0);

    const topMaterials = rows.slice(0, limit).map((r: any) => ({
        materialName: r._id || 'Vật tư',
        unit: r.unit || '',
        qty: Math.round(r.qty || 0),
        value: Math.round(r.value || 0),
        shortageQty: Math.round(r.shortageQty || 0),
    }));
    const topShortages = rows
        .filter((r: any) => (r.shortageQty || 0) > 0)
        .sort((a: any, b: any) => b.shortageQty - a.shortageQty)
        .slice(0, limit)
        .map((r: any) => ({ materialName: r._id || 'Vật tư', unit: r.unit || '', shortageQty: Math.round(r.shortageQty || 0) }));

    return {
        periodLabel,
        plantName: plantId ? nameById.get(plantId) : undefined,
        totalValue: Math.round(totalValue),
        totalQty: Math.round(totalQty),
        totalShortageQty: Math.round(totalShortageQty),
        totalShortageLines,
        topMaterials,
        topShortages,
    };
};

// ============================================================
// 7) ĐỀ XUẤT MUA: tồn dưới định mức + tốc độ tiêu hao 30 ngày
// ============================================================
export const purchaseSuggestion = async (args: { limit?: number }) => {
    const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 25);
    const since = subDays(new Date(), 30);

    // Tồn hiện tại theo vật tư.
    const stockRows = await InventoryStock.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$materialId', stock: { $sum: '$currentStock' } } },
    ]);
    const stockByMaterial = new Map<string, number>(stockRows.map((r: any) => [String(r._id), Number(r.stock) || 0]));

    // Tiêu hao 30 ngày (đã cấp phát).
    const usageRows = await DistributionRecord.aggregate([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] }, createdAt: { $gte: since } } },
        { $unwind: '$items' },
        { $match: { 'items.materialId': { $ne: null } } },
        { $group: { _id: '$items.materialId', used: { $sum: DIST_QTY } } },
    ]);
    const usageByMaterial = new Map<string, number>(usageRows.map((r: any) => [String(r._id), Number(r.used) || 0]));

    const materials = await Material.find({ isDeleted: { $ne: true }, isActive: { $ne: false }, trackInventory: { $ne: false } })
        .select('_id name code unit minStockLevel')
        .lean();

    const suggestions = materials
        .map((m: any) => {
            const id = String(m._id);
            const stock = stockByMaterial.get(id) ?? 0;
            const used30 = usageByMaterial.get(id) ?? 0;
            const minLevel = Number(m.minStockLevel) || 0;
            // Cần mua khi: dưới định mức, HOẶC tồn không đủ tiêu hao 30 ngày tới.
            const target = Math.max(minLevel, used30); // mục tiêu giữ đủ định mức + đủ dùng 1 tháng
            const suggestQty = Math.ceil(target - stock);
            return {
                materialName: m.name,
                code: m.code,
                unit: m.unit || '',
                stock: Math.round(stock),
                minLevel: Math.round(minLevel),
                used30: Math.round(used30),
                suggestQty,
                // ưu tiên: thiếu càng nhiều so với nhu cầu càng gấp
                urgency: target > 0 ? (target - stock) / target : 0,
            };
        })
        .filter((s) => s.suggestQty > 0 && (s.minLevel > 0 || s.used30 > 0))
        .sort((a, b) => b.urgency - a.urgency)
        .slice(0, limit);

    return { count: suggestions.length, suggestions };
};
