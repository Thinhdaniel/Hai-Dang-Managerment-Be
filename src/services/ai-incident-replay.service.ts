import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { endOfDay, format, startOfDay, subDays } from 'date-fns';
import Asset from '@/models/Asset';
import DistributionRecord from '@/models/DistributionRecord';
import Maintenance from '@/models/Maintenance';
import Plant from '@/models/Plant';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import { AI_FEATURES } from '@/constant/aiModels';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import customResponse from '@/utils/response';

type ReplaySeverity = 'info' | 'warning' | 'danger' | 'success';
type ReplayDomain = 'purchase' | 'distribution' | 'maintenance' | 'asset' | 'mixed';

type ReplayEvent = {
    id: string;
    type: ReplayDomain;
    at: string;
    title: string;
    subtitle?: string;
    value?: number;
    severity: ReplaySeverity;
    route?: string;
    evidence?: string[];
};

type ReplayDriver = {
    label: string;
    value: number;
    count: number;
    domain: ReplayDomain;
    detail?: string;
};

type ReplayMetric = {
    key: string;
    label: string;
    current: number;
    previous: number;
    delta: number;
    deltaPct: number;
    unit: 'vnd' | 'count';
};

type ReplayCaseSeverity = 'normal' | 'watch' | 'high' | 'critical';

type ReplayRootCauseChain = {
    title: string;
    severity: ReplaySeverity;
    confidence: number;
    value: number;
    domain: ReplayDomain;
    steps: string[];
    evidence: string[];
};

type ReplayRecommendation = {
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high';
    route?: string;
};

const money = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
};

const round0 = (v: number) => Math.round(v || 0);

const pct = (current: number, previous: number) => {
    if (previous > 0) return Math.round(((current - previous) / previous) * 100);
    return current > 0 ? 100 : 0;
};

const clampDays = (value: unknown) => {
    const days = Number(value || 30);
    if (!Number.isFinite(days)) return 30;
    return Math.min(Math.max(Math.round(days), 7), 180);
};

const buildRange = (days: number) => {
    const end = endOfDay(new Date());
    const start = startOfDay(subDays(end, days - 1));
    const prevEnd = endOfDay(subDays(start, 1));
    const prevStart = startOfDay(subDays(prevEnd, days - 1));
    return { start, end, prevStart, prevEnd };
};

const dateInRange = (start: Date, end: Date) => ({ $gte: start, $lte: end });

const iso = (date?: Date | string | null) => {
    const d = date ? new Date(date) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
};

const dateLabel = (date?: Date | string | null) => {
    const d = date ? new Date(date) : null;
    return d && !Number.isNaN(d.getTime()) ? format(d, 'dd/MM/yyyy') : '-';
};

const normalize = (v?: string) =>
    (v ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/\s+/g, ' ')
        .trim();

const inferFocus = (question: string): ReplayDomain => {
    const q = normalize(question);
    const hasPurchase = ['mua', 'don hang', 'dat hang', 'ncc', 'nha cung cap', 'nhan hang'].some((k) => q.includes(k));
    const hasDistribution = ['cap phat', 'xuat kho', 'de xuat cap', 'vat tu'].some((k) => q.includes(k));
    const hasMaintenance = ['bao tri', 'sua', 'hong', 'sua ngoai'].some((k) => q.includes(k));
    const hasAsset = ['may', 'dieu chuyen', 'thanh ly', 'kiem ke'].some((k) => q.includes(k));
    const count = [hasPurchase, hasDistribution, hasMaintenance, hasAsset].filter(Boolean).length;
    if (count !== 1) return 'mixed';
    if (hasPurchase) return 'purchase';
    if (hasDistribution) return 'distribution';
    if (hasMaintenance) return 'maintenance';
    return 'asset';
};

const itemValue = (item: any) =>
    money(item?.totalWithVat ?? item?.totalPrice ?? money(item?.unitPrice) * money(item?.quantityOrdered ?? item?.quantity ?? item?.quantityDistributed));

const pushDriver = (map: Map<string, ReplayDriver>, key: string, value: number, domain: ReplayDomain, detail?: string) => {
    const safeKey = key || 'Chưa rõ';
    const current = map.get(safeKey) ?? { label: safeKey, value: 0, count: 0, domain, detail };
    current.value += value;
    current.count += 1;
    current.detail = current.detail || detail;
    map.set(safeKey, current);
};

const eventValueSeverity = (value: number): ReplaySeverity => {
    if (value >= 20_000_000) return 'danger';
    if (value >= 5_000_000) return 'warning';
    return 'info';
};

const computeCaseSeverity = (metrics: ReplayMetric[], flags: string[], drivers: ReplayDriver[]) => {
    let score = 0;
    for (const metric of metrics) {
        if (metric.unit === 'vnd') {
            if (metric.current >= 50_000_000) score += 25;
            else if (metric.current >= 20_000_000) score += 18;
            else if (metric.current >= 5_000_000) score += 10;
        }
        if (metric.deltaPct >= 100 && metric.current > 0) score += 22;
        else if (metric.deltaPct >= 50 && metric.current > 0) score += 14;
        else if (metric.deltaPct >= 25 && metric.current > 0) score += 8;
    }
    if (drivers[0]?.value >= 20_000_000) score += 18;
    if (drivers[0]?.value >= 5_000_000) score += 10;
    score += Math.min(flags.length * 8, 24);
    score = Math.min(score, 100);
    const severity: ReplayCaseSeverity = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'watch' : 'normal';
    return { score, severity };
};

const buildRootCauseChains = (drivers: ReplayDriver[], events: ReplayEvent[], metrics: ReplayMetric[]) => {
    const chains: ReplayRootCauseChain[] = [];
    const topMetrics = metrics
        .filter((m) => m.current > 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3);

    for (const driver of drivers.slice(0, 5)) {
        const relatedEvents = events.filter((e) => e.type === driver.domain || e.evidence?.some((line) => normalize(line).includes(normalize(driver.label).slice(0, 18))));
        const metric = topMetrics.find((m) => {
            if (driver.domain === 'purchase') return m.key === 'purchase_value';
            if (driver.domain === 'distribution') return m.key === 'distribution_value';
            if (driver.domain === 'maintenance') return m.key === 'maintenance_cost' || m.key === 'maintenance_count';
            return false;
        });
        const valueShare = metric?.current ? Math.round((driver.value / metric.current) * 100) : 0;
        const confidence = Math.min(95, 45 + Math.min(driver.count * 8, 24) + (relatedEvents.length ? 15 : 0) + (valueShare >= 30 ? 12 : 0));
        const severity: ReplaySeverity = driver.value >= 20_000_000 || valueShare >= 60 ? 'danger' : driver.value >= 5_000_000 || valueShare >= 30 ? 'warning' : 'info';
        chains.push({
            title: driver.label,
            severity,
            confidence,
            value: driver.value,
            domain: driver.domain,
            steps: [
                metric
                    ? `${metric.label} kỳ này là ${round0(metric.current).toLocaleString('vi-VN')}${metric.unit === 'vnd' ? 'đ' : ''}, chênh ${metric.deltaPct}% so với kỳ trước.`
                    : 'Có phát sinh đáng chú ý trong kỳ phân tích.',
                `${driver.label} đóng góp ${round0(driver.value).toLocaleString('vi-VN')}đ qua ${driver.count} dòng/sự kiện.`,
                valueShare > 0 ? `Tỷ trọng ước tính trong nhóm liên quan: ${valueShare}%.` : 'Chưa đủ dữ liệu để tính tỷ trọng chính xác.',
                relatedEvents[0] ? `Sự kiện gần nhất: ${relatedEvents[0].title} (${dateLabel(relatedEvents[0].at)}).` : 'Chưa có sự kiện timeline đủ rõ để liên kết sâu.',
            ],
            evidence: relatedEvents.slice(0, 4).map((e) => `${dateLabel(e.at)} · ${e.title}${e.value ? ` · ${round0(e.value).toLocaleString('vi-VN')}đ` : ''}`),
        });
    }
    return chains;
};

const buildRecommendations = (metrics: ReplayMetric[], drivers: ReplayDriver[], flags: string[]): ReplayRecommendation[] => {
    const recs: ReplayRecommendation[] = [];
    const purchase = metrics.find((m) => m.key === 'purchase_value');
    const distribution = metrics.find((m) => m.key === 'distribution_value');
    const maintenance = metrics.find((m) => m.key === 'maintenance_cost');
    const top = drivers[0];

    if (purchase && purchase.deltaPct >= 50 && purchase.current > 0) {
        recs.push({
            title: 'Đối soát đơn mua và NCC',
            description: 'Kiểm tra đơn mua lớn, đơn giá, NCC và các dòng vật tư chiếm tỷ trọng cao trong kỳ.',
            priority: 'high',
            route: '/materials/purchase-orders',
        });
    }
    if (distribution && distribution.deltaPct >= 50 && distribution.current > 0) {
        recs.push({
            title: 'Rà lại phiếu cấp phát theo cơ sở nhận',
            description: 'So các phiếu cấp phát lớn với đề xuất gốc, mục đích sử dụng và người nhận để loại trừ cấp phát sai/nhập thiếu thông tin.',
            priority: 'high',
            route: '/materials/distributions',
        });
    }
    if (maintenance && maintenance.current > 0) {
        recs.push({
            title: 'Gắn chi phí bảo trì với máy lặp lỗi',
            description: 'Kiểm tra nhóm máy phát sinh sửa ngoài hoặc quá hạn để quyết định sửa tiếp, thay linh kiện định kỳ hoặc đưa vào diện thanh lý.',
            priority: maintenance.deltaPct >= 50 ? 'high' : 'medium',
            route: '/maintenances',
        });
    }
    if (top) {
        recs.push({
            title: `Khoanh vùng tác nhân: ${top.label}`,
            description: `Đây là driver lớn nhất trong kỳ với ${round0(top.value).toLocaleString('vi-VN')}đ qua ${top.count} dòng/sự kiện. Nên mở chứng từ gốc để xác minh.`,
            priority: top.value >= 5_000_000 ? 'high' : 'medium',
            route:
                top.domain === 'purchase'
                    ? '/materials/purchase-orders'
                    : top.domain === 'distribution'
                      ? '/materials/distributions'
                      : top.domain === 'maintenance'
                        ? '/maintenances'
                        : undefined,
        });
    }
    if (flags.some((f) => normalize(f).includes('nhap') || normalize(f).includes('cho duyet'))) {
        recs.push({
            title: 'Dọn luồng phiếu đang kẹt',
            description: 'Các phiếu nháp/chờ duyệt có thể làm số liệu bị lệch thời điểm. Cần chốt trạng thái trước khi báo cáo.',
            priority: 'medium',
        });
    }
    return recs.slice(0, 5);
};

const loadPlants = async () => {
    const plants = await Plant.find({ isDeleted: { $ne: true } }).select('_id name code').lean();
    return new Map(plants.map((p: any) => [String(p._id), String(p.name || p.code || 'Chưa rõ')]));
};

const sumPurchaseOrders = async (start: Date, end: Date) => {
    const rows = await PurchaseOrder.aggregate([
        {
            $match: {
                isDeleted: { $ne: true },
                $or: [
                    { createdAt: dateInRange(start, end) },
                    { orderedAt: dateInRange(start, end) },
                    { receivedAt: dateInRange(start, end) },
                ],
            },
        },
        { $unwind: '$items' },
        { $group: { _id: null, value: { $sum: { $ifNull: ['$items.totalWithVat', { $ifNull: ['$items.totalPrice', 0] }] } }, count: { $addToSet: '$_id' } } },
    ]);
    return { value: round0(rows[0]?.value || 0), count: rows[0]?.count?.length || 0 };
};

const sumDistributions = async (start: Date, end: Date) => {
    const rows = await DistributionRecord.aggregate([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] } } },
        { $addFields: { effectiveAt: { $ifNull: ['$distributedAt', { $ifNull: ['$confirmedAt', '$createdAt'] }] } } },
        { $match: { effectiveAt: dateInRange(start, end) } },
        { $unwind: '$items' },
        { $group: { _id: null, value: { $sum: { $ifNull: ['$items.totalWithVat', { $ifNull: ['$items.totalPrice', 0] }] } }, count: { $addToSet: '$_id' } } },
    ]);
    return { value: round0(rows[0]?.value || 0), count: rows[0]?.count?.length || 0 };
};

const sumMaintenances = async (start: Date, end: Date) => {
    const rows = await Maintenance.aggregate([
        { $match: { isDeleted: { $ne: true }, startDate: dateInRange(start, end) } },
        {
            $group: {
                _id: null,
                value: { $sum: { $ifNull: ['$externalRepair.actualCost', { $ifNull: ['$cost', 0] }] } },
                count: { $sum: 1 },
            },
        },
    ]);
    return { value: round0(rows[0]?.value || 0), count: rows[0]?.count || 0 };
};

const buildAiNarrative = async (payload: {
    question: string;
    periodLabel: string;
    focus: ReplayDomain;
    caseScore: number;
    caseSeverity: ReplayCaseSeverity;
    metrics: ReplayMetric[];
    drivers: ReplayDriver[];
    rootCauseChains: ReplayRootCauseChain[];
    recommendations: ReplayRecommendation[];
    events: ReplayEvent[];
    flags: string[];
}) => {
    const fallback = () => {
        const top = payload.drivers[0];
        const changed = payload.metrics
            .filter((m) => m.delta !== 0)
            .map((m) => `${m.label} ${m.delta >= 0 ? 'tăng' : 'giảm'} ${Math.abs(m.deltaPct)}%`)
            .slice(0, 3)
            .join(', ');
        return [
            `Replay ${payload.periodLabel}: ${changed || 'chưa thấy biến động lớn từ các nhóm chính'}.`,
            top ? `Tác nhân lớn nhất là ${top.label} với giá trị ${round0(top.value).toLocaleString('vi-VN')}đ qua ${top.count} dòng/sự kiện.` : '',
            payload.flags[0] ? `Điểm cần kiểm tra: ${payload.flags[0]}.` : '',
        ]
            .filter(Boolean)
            .join(' ');
    };

    try {
        const result = await aiProviderService.generateText({
            feature: AI_FEATURES.INCIDENT_REPLAY,
            temperature: 0.15,
            maxTokens: 850,
            messages: [
                {
                    role: 'system',
                    content:
                        'Bạn là trợ lý điều tra vận hành cho công ty may. Chỉ phân tích dựa trên JSON được cung cấp. Không bịa số liệu. Trả lời tiếng Việt, ngắn, có nguyên nhân chính, bằng chứng và hành động đề xuất.',
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        question: payload.question,
                        period: payload.periodLabel,
                        focus: payload.focus,
                        caseScore: payload.caseScore,
                        caseSeverity: payload.caseSeverity,
                        metrics: payload.metrics,
                        rootCauseChains: payload.rootCauseChains.slice(0, 5),
                        recommendations: payload.recommendations,
                        topDrivers: payload.drivers.slice(0, 8),
                        timeline: payload.events.slice(0, 12),
                        flags: payload.flags,
                    }),
                },
            ],
        });
        return {
            narrative: result.content,
            provider: result.provider,
            model: result.model,
            aiUsed: true,
        };
    } catch {
        return { narrative: fallback(), provider: 'fallback', aiUsed: false };
    }
};

export const runIncidentReplay = async (req: Request, res: Response) => {
    const question = String(req.body.question || '').trim();
    const days = clampDays(req.body.periodDays);
    const { start, end, prevStart, prevEnd } = buildRange(days);
    const focus = inferFocus(question);
    const plantNames = await loadPlants();
    const periodLabel = `${dateLabel(start)} - ${dateLabel(end)}`;

    const [purchaseCur, purchasePrev, distCur, distPrev, maintCur, maintPrev, statusRows] = await Promise.all([
        sumPurchaseOrders(start, end),
        sumPurchaseOrders(prevStart, prevEnd),
        sumDistributions(start, end),
        sumDistributions(prevStart, prevEnd),
        sumMaintenances(start, end),
        sumMaintenances(prevStart, prevEnd),
        Asset.aggregate([
            { $match: { isDeleted: { $ne: true } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]),
    ]);

    const metrics: ReplayMetric[] = [
        {
            key: 'purchase_value',
            label: 'Chi phí mua vật tư',
            current: purchaseCur.value,
            previous: purchasePrev.value,
            delta: purchaseCur.value - purchasePrev.value,
            deltaPct: pct(purchaseCur.value, purchasePrev.value),
            unit: 'vnd',
        },
        {
            key: 'distribution_value',
            label: 'Chi phí cấp phát',
            current: distCur.value,
            previous: distPrev.value,
            delta: distCur.value - distPrev.value,
            deltaPct: pct(distCur.value, distPrev.value),
            unit: 'vnd',
        },
        {
            key: 'maintenance_cost',
            label: 'Chi phí bảo trì',
            current: maintCur.value,
            previous: maintPrev.value,
            delta: maintCur.value - maintPrev.value,
            deltaPct: pct(maintCur.value, maintPrev.value),
            unit: 'vnd',
        },
        {
            key: 'maintenance_count',
            label: 'Số phiếu bảo trì',
            current: maintCur.count,
            previous: maintPrev.count,
            delta: maintCur.count - maintPrev.count,
            deltaPct: pct(maintCur.count, maintPrev.count),
            unit: 'count',
        },
    ];

    const driverMap = new Map<string, ReplayDriver>();
    const events: ReplayEvent[] = [];

    const [purchaseOrders, distributions, maintenances, requests] = await Promise.all([
        PurchaseOrder.find({
            isDeleted: { $ne: true },
            $or: [
                { createdAt: dateInRange(start, end) },
                { orderedAt: dateInRange(start, end) },
                { receivedAt: dateInRange(start, end) },
            ],
        })
            .sort({ receivedAt: -1, orderedAt: -1, createdAt: -1 })
            .limit(40)
            .lean(),
        DistributionRecord.find({
            isDeleted: { $ne: true },
            status: { $in: ['distributed', 'confirmed'] },
            $or: [
                { distributedAt: dateInRange(start, end) },
                { confirmedAt: dateInRange(start, end) },
                { createdAt: dateInRange(start, end) },
            ],
        })
            .sort({ distributedAt: -1, confirmedAt: -1, createdAt: -1 })
            .limit(40)
            .lean(),
        Maintenance.find({ isDeleted: { $ne: true }, startDate: dateInRange(start, end) })
            .populate('assetId', 'machineCode name type')
            .populate('assetIds', 'machineCode name type')
            .sort({ startDate: -1 })
            .limit(40)
            .lean(),
        PurchaseRequest.find({
            isDeleted: { $ne: true },
            requestType: { $in: ['purchase', 'supply_request', 'technical_purchase'] },
            createdAt: dateInRange(start, end),
        })
            .sort({ createdAt: -1 })
            .limit(40)
            .lean(),
    ]);

    for (const order of purchaseOrders as any[]) {
        const value = (order.items || []).reduce((sum: number, item: any) => {
            const v = itemValue(item);
            pushDriver(driverMap, item.materialName || 'Vật tư mua chưa rõ tên', v, 'purchase', order.orderCode);
            if (item.supplierName) pushDriver(driverMap, `NCC: ${item.supplierName}`, v, 'purchase', order.orderCode);
            if (item.plantName || item.plantId) pushDriver(driverMap, `Cơ sở mua: ${item.plantName || plantNames.get(String(item.plantId))}`, v, 'purchase', order.orderCode);
            return sum + v;
        }, 0);
        events.push({
            id: String(order._id),
            type: 'purchase',
            at: iso(order.receivedAt || order.orderedAt || order.createdAt),
            title: `Đơn mua ${order.orderCode || '-'}`,
            subtitle: `${order.supplierName || 'Chưa rõ NCC'} · ${order.status || '-'}`,
            value: round0(value),
            severity: eventValueSeverity(value),
            route: '/materials/purchase-orders',
            evidence: (order.items || []).slice(0, 3).map((it: any) => `${it.materialName || 'Vật tư'}: ${money(it.quantityOrdered).toLocaleString('vi-VN')} ${it.unit || ''}`),
        });
    }

    for (const record of distributions as any[]) {
        const value = (record.items || []).reduce((sum: number, item: any) => {
            const v = itemValue(item);
            pushDriver(driverMap, item.materialName || 'Vật tư cấp phát chưa rõ tên', v, 'distribution', record.distributionCode);
            return sum + v;
        }, 0);
        const toPlant = plantNames.get(String(record.toPlantId)) || 'Chưa rõ nơi nhận';
        events.push({
            id: String(record._id),
            type: 'distribution',
            at: iso(record.distributedAt || record.confirmedAt || record.createdAt),
            title: `Phiếu cấp phát ${record.distributionCode || '-'}`,
            subtitle: `${toPlant} · ${record.status || '-'}`,
            value: round0(value),
            severity: eventValueSeverity(value),
            route: '/materials/distributions',
            evidence: (record.items || []).slice(0, 3).map((it: any) => `${it.materialName || 'Vật tư'}: ${money(it.quantityDistributed ?? it.quantity).toLocaleString('vi-VN')} ${it.unit || ''}`),
        });
    }

    for (const mt of maintenances as any[]) {
        const value = money(mt.externalRepair?.actualCost ?? mt.cost);
        const asset = mt.assetId && typeof mt.assetId === 'object' ? mt.assetId : undefined;
        const assetCodes = Array.isArray(mt.assetIds)
            ? mt.assetIds.filter((a: any) => a && typeof a === 'object').map((a: any) => a.machineCode || a.name).filter(Boolean)
            : [];
        pushDriver(driverMap, `Bảo trì: ${mt.repairMode === 'external' ? 'sửa ngoài' : 'nội bộ'}`, value || 1, 'maintenance', mt.description);
        if (mt.plantName || mt.plantId) pushDriver(driverMap, `Cơ sở bảo trì: ${mt.plantName || plantNames.get(String(mt.plantId))}`, value || 1, 'maintenance');
        events.push({
            id: String(mt._id),
            type: 'maintenance',
            at: iso(mt.startDate || mt.createdAt),
            title: `Bảo trì ${asset?.machineCode || assetCodes[0] || 'máy'}`,
            subtitle: `${mt.repairMode === 'external' ? 'Sửa ngoài' : 'Nội bộ'} · ${mt.status || '-'} · ${mt.description || ''}`.slice(0, 160),
            value: round0(value),
            severity: mt.status === 'overdue' || value >= 5_000_000 ? 'warning' : 'info',
            route: '/maintenances',
            evidence: assetCodes.slice(0, 5),
        });
    }

    for (const request of requests as any[]) {
        const value = money(request.totalWithVat || request.totalActual || request.totalEstimated);
        events.push({
            id: String(request._id),
            type: request.requestType === 'supply_request' ? 'distribution' : 'purchase',
            at: iso(request.createdAt),
            title: `Đề xuất ${request.requestCode || '-'}`,
            subtitle: `${request.requestType || '-'} · ${request.status || '-'} · ${(request.items || []).length} dòng`,
            value: round0(value),
            severity: ['pending', 'draft'].includes(request.status) ? 'warning' : 'info',
            route: request.requestType === 'supply_request' ? '/materials/supply-requests' : '/materials/purchase-requests',
            evidence: (request.items || []).slice(0, 3).map((it: any) => `${it.materialName || 'Vật tư'}: ${money(it.quantityRequested).toLocaleString('vi-VN')} ${it.unit || ''}`),
        });
    }

    const drivers = [...driverMap.values()]
        .map((d) => ({ ...d, value: round0(d.value) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 12);

    const flags: string[] = [];
    const highMetrics = metrics.filter((m) => m.deltaPct >= 50 && m.current > 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    highMetrics.slice(0, 3).forEach((m) => flags.push(`${m.label} tăng ${m.deltaPct}% so với kỳ trước`));
    const pendingRequests = requests.filter((r: any) => ['draft', 'pending'].includes(r.status)).length;
    if (pendingRequests) flags.push(`${pendingRequests} đề xuất đang ở trạng thái nháp/chờ duyệt trong kỳ`);
    const overdueMaint = maintenances.filter((m: any) => m.status === 'overdue').length;
    if (overdueMaint) flags.push(`${overdueMaint} phiếu bảo trì quá hạn`);
    const riskyStatus = (statusRows as any[])
        .filter((r) => ['broken', 'maintenance', 'pending_disposal'].includes(String(r._id)))
        .map((r) => `${r.count} máy ${r._id}`)
        .join(', ');
    if (riskyStatus) flags.push(`Hiện trạng máy cần chú ý: ${riskyStatus}`);

    const sortedEvents = events
        .sort((a, b) => Number(new Date(b.at)) - Number(new Date(a.at)) || (b.value || 0) - (a.value || 0))
        .slice(0, 30);
    const rootCauseChains = buildRootCauseChains(drivers, sortedEvents, metrics);
    const recommendations = buildRecommendations(metrics, drivers, flags);
    const caseHealth = computeCaseSeverity(metrics, flags, drivers);

    const ai = await buildAiNarrative({
        question,
        periodLabel,
        focus,
        caseScore: caseHealth.score,
        caseSeverity: caseHealth.severity,
        metrics,
        drivers,
        rootCauseChains,
        recommendations,
        events: sortedEvents,
        flags,
    });

    const data = {
        question,
        focus,
        periodDays: days,
        periodLabel,
        previousPeriodLabel: `${dateLabel(prevStart)} - ${dateLabel(prevEnd)}`,
        caseScore: caseHealth.score,
        caseSeverity: caseHealth.severity,
        metrics,
        drivers,
        rootCauseChains,
        recommendations,
        events: sortedEvents,
        flags,
        narrative: ai.narrative,
        provider: ai.provider,
        model: ai.model,
        aiUsed: ai.aiUsed,
        generatedAt: new Date().toISOString(),
    };

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Đã dựng lại timeline sự cố',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
