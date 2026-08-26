import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { endOfDay, format, startOfDay, subDays } from 'date-fns';
import Asset from '@/models/Asset';
import DistributionRecord from '@/models/DistributionRecord';
import IncidentReplayHistory from '@/models/IncidentReplayHistory';
import Maintenance from '@/models/Maintenance';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import Supplier from '@/models/Supplier';
import { AI_FEATURES } from '@/constant/aiModels';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { getActorName } from '@/services/notification.helper';
import customResponse from '@/utils/response';

type ReplaySeverity = 'info' | 'warning' | 'danger' | 'success';
type ReplayDomain = 'purchase' | 'distribution' | 'maintenance' | 'asset' | 'mixed';
type ReplayWorkflowAction = 'review' | 'approve' | 'close' | 'reopen';

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

const loadPlantContext = async () => {
    const rows = await Plant.find({ isDeleted: { $ne: true } }).select('_id name code').lean();
    return {
        rows,
        nameById: new Map(rows.map((p: any) => [String(p._id), String(p.name || p.code || 'Chưa rõ')])),
    };
};

const loadReplayFeedbackLessons = async (userId?: string) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        'feedback.rating': { $in: ['wrong', 'missing_data', 'irrelevant'] },
    };
    if (userId) filter.createdBy = userId;
    const rows = await IncidentReplayHistory.find(filter)
        .select('question focus periodLabel feedback narrative flags createdAt')
        .sort({ 'feedback.createdAt': -1, createdAt: -1 })
        .limit(5)
        .lean();
    return rows.map((row: any) => ({
        question: row.question,
        focus: row.focus,
        period: row.periodLabel,
        rating: row.feedback?.rating,
        note: row.feedback?.note,
        flags: (row.flags || []).slice(0, 3),
        previousAnswer: String(row.narrative || '').slice(0, 500),
    }));
};

const runIncidentReplayV2 = async (req: Request, res: Response) => {
    const question = String(req.body.question || '').trim();
    const sessionId = String(req.body.sessionId || req.headers['x-session-id'] || req.user?._id || 'default');
    const prevContext = replayContextStore.get(sessionId);
    const requestedDays = clampDays(req.body.periodDays || prevContext?.periodDays);
    const { start, end, prevStart, prevEnd, days } = parseNaturalRange(question, requestedDays);
    const focus = inferFocus(question) === 'mixed' && prevContext?.focus ? prevContext.focus : inferFocus(question);
    const plantContext = await loadPlantContext();
    const parsedScope = extractScope(question, plantContext.rows);
    const scope = await resolveScopeEntities(mergeScope(parsedScope, prevContext?.scope), question, plantContext.rows);
    const periodLabel = `${dateLabel(start)} - ${dateLabel(end)}`;

    const [currentFacts, previousFacts, statusRows] = await Promise.all([
        collectReplayFacts(start, end, scope, plantContext.nameById, true),
        collectReplayFacts(prevStart, prevEnd, scope, plantContext.nameById, false),
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
            current: currentFacts.purchaseValue,
            previous: previousFacts.purchaseValue,
            delta: currentFacts.purchaseValue - previousFacts.purchaseValue,
            deltaPct: pct(currentFacts.purchaseValue, previousFacts.purchaseValue),
            unit: 'vnd',
        },
        {
            key: 'distribution_value',
            label: 'Chi phí cấp phát',
            current: currentFacts.distributionValue,
            previous: previousFacts.distributionValue,
            delta: currentFacts.distributionValue - previousFacts.distributionValue,
            deltaPct: pct(currentFacts.distributionValue, previousFacts.distributionValue),
            unit: 'vnd',
        },
        {
            key: 'maintenance_cost',
            label: 'Chi phí bảo trì',
            current: currentFacts.maintenanceCost,
            previous: previousFacts.maintenanceCost,
            delta: currentFacts.maintenanceCost - previousFacts.maintenanceCost,
            deltaPct: pct(currentFacts.maintenanceCost, previousFacts.maintenanceCost),
            unit: 'vnd',
        },
        {
            key: 'maintenance_count',
            label: 'Số phiếu bảo trì',
            current: currentFacts.maintenanceCount,
            previous: previousFacts.maintenanceCount,
            delta: currentFacts.maintenanceCount - previousFacts.maintenanceCount,
            deltaPct: pct(currentFacts.maintenanceCount, previousFacts.maintenanceCount),
            unit: 'count',
        },
    ];

    const drivers = buildDrivers(currentFacts.driverMap).slice(0, 18);
    const previousDrivers = buildDrivers(previousFacts.driverMap).slice(0, 18);
    const flags: string[] = [];
    if (scope.applied) flags.push(`Đã áp dụng phạm vi: ${scope.notes.join(' · ')}`);
    metrics
        .filter((m) => m.deltaPct >= 50 && m.current > 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3)
        .forEach((m) => flags.push(`${m.label} tăng ${m.deltaPct}% so với kỳ trước`));
    if (currentFacts.pendingRequests) flags.push(`${currentFacts.pendingRequests} đề xuất đang ở trạng thái nháp/chờ duyệt trong kỳ`);
    if (currentFacts.overdueMaintenances) flags.push(`${currentFacts.overdueMaintenances} phiếu bảo trì quá hạn`);
    const riskyStatus = (statusRows as any[])
        .filter((r) => ['broken', 'maintenance', 'pending_disposal'].includes(String(r._id)))
        .map((r) => `${r.count} máy ${r._id}`)
        .join(', ');
    if (riskyStatus) flags.push(`Hiện trạng máy cần chú ý: ${riskyStatus}`);

    const sortedEvents = currentFacts.events
        .sort((a, b) => Number(new Date(b.at)) - Number(new Date(a.at)) || (b.value || 0) - (a.value || 0))
        .slice(0, 40);
    const breakdowns = buildBreakdowns(drivers, previousDrivers);
    const anomalies = buildAnomalies(metrics, drivers, previousDrivers, sortedEvents, flags);
    const rootCauseChains = buildRootCauseChains(drivers, sortedEvents, metrics);
    const recommendations = buildRecommendations(metrics, drivers, flags);
    const caseHealth = computeCaseSeverity(metrics, flags, drivers);
    const feedbackLessons = await loadReplayFeedbackLessons(req.userId);
    const actorName = await getActorName(req.userId);

    const ai = await buildAiNarrative({
        question,
        periodLabel,
        focus,
        scope,
        caseScore: caseHealth.score,
        caseSeverity: caseHealth.severity,
        metrics,
        drivers,
        anomalies,
        breakdowns,
        rootCauseChains,
        recommendations,
        events: sortedEvents,
        flags,
        feedbackLessons,
    });

    const data = {
        version: 6,
        sessionId,
        question,
        focus,
        periodDays: days,
        periodLabel,
        previousPeriodLabel: `${dateLabel(prevStart)} - ${dateLabel(prevEnd)}`,
        scope,
        caseScore: caseHealth.score,
        caseSeverity: caseHealth.severity,
        metrics,
        drivers,
        previousDrivers,
        breakdowns,
        anomalies,
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

    const history = await IncidentReplayHistory.create({
        sessionId,
        version: 6,
        question,
        focus,
        periodDays: days,
        periodLabel,
        previousPeriodLabel: `${dateLabel(prevStart)} - ${dateLabel(prevEnd)}`,
        scope,
        caseScore: caseHealth.score,
        caseSeverity: caseHealth.severity,
        metrics,
        drivers,
        breakdowns,
        anomalies,
        rootCauseChains,
        recommendations,
        events: sortedEvents,
        flags,
        narrative: ai.narrative,
        provider: ai.provider,
        model: ai.model,
        aiUsed: ai.aiUsed,
        createdBy: req.userId,
        workflowStatus: 'draft',
        auditTrail: [
            {
                action: 'created',
                note: 'AI tạo hồ sơ điều tra ban đầu',
                userId: req.userId,
                userName: actorName,
                at: new Date(),
            },
        ],
    });
    (data as any).historyId = String(history._id);

    replayContextStore.set(sessionId, {
        scope,
        periodDays: days,
        focus,
        question,
        updatedAt: Date.now(),
    });
    for (const [key, value] of replayContextStore.entries()) {
        if (Date.now() - value.updatedAt > CONTEXT_TTL_MS) replayContextStore.delete(key);
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Đã dựng lại hồ sơ điều tra V6',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const serializeReplayHistory = (item: any, compact = true) => ({
    id: String(item._id),
    sessionId: item.sessionId,
    version: item.version || 5,
    question: item.question,
    focus: item.focus,
    periodDays: item.periodDays,
    periodLabel: item.periodLabel,
    previousPeriodLabel: item.previousPeriodLabel,
    caseScore: item.caseScore,
    caseSeverity: item.caseSeverity,
    scope: item.scope,
    flags: item.flags || [],
    narrative: compact ? undefined : item.narrative,
    metrics: compact ? undefined : item.metrics,
    drivers: compact ? undefined : item.drivers,
    breakdowns: compact ? undefined : item.breakdowns,
    anomalies: compact ? undefined : item.anomalies,
    rootCauseChains: compact ? undefined : item.rootCauseChains,
    recommendations: compact ? undefined : item.recommendations,
    events: compact ? undefined : item.events,
    feedback: item.feedback,
    workflowStatus: item.workflowStatus || 'draft',
    reviewNote: item.reviewNote,
    managerConclusion: item.managerConclusion,
    reviewedByName: item.reviewedByName,
    reviewedAt: item.reviewedAt,
    approvedByName: item.approvedByName,
    approvedAt: item.approvedAt,
    closedByName: item.closedByName,
    closedAt: item.closedAt,
    auditTrail: compact ? undefined : item.auditTrail || [],
    generatedAt: item.createdAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
});

export const getIncidentReplayHistory = async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    if (req.userId) filter.createdBy = req.userId;
    const rows = await IncidentReplayHistory.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: rows.map((row) => serializeReplayHistory(row)),
            message: 'Lịch sử Incident Replay',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getIncidentReplayHistoryById = async (req: Request, res: Response) => {
    const filter: Record<string, any> = { _id: req.params.id, isDeleted: { $ne: true } };
    if (req.userId) filter.createdBy = req.userId;
    const item = await IncidentReplayHistory.findOne(filter).lean();
    if (!item) {
        return res.status(StatusCodes.NOT_FOUND).json(
            customResponse({
                data: null,
                message: 'Không tìm thấy replay',
                status: StatusCodes.NOT_FOUND,
                success: false,
            })
        );
    }
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeReplayHistory(item, false),
            message: 'Chi tiết Incident Replay',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const submitIncidentReplayFeedback = async (req: Request, res: Response) => {
    const rating = String(req.body.rating || '');
    if (!['accurate', 'wrong', 'missing_data', 'irrelevant'].includes(rating)) {
        return res.status(StatusCodes.BAD_REQUEST).json(
            customResponse({
                data: null,
                message: 'Feedback không hợp lệ',
                status: StatusCodes.BAD_REQUEST,
                success: false,
            })
        );
    }
    const filter: Record<string, any> = { _id: req.params.id, isDeleted: { $ne: true } };
    if (req.userId) filter.createdBy = req.userId;
    const updated = await IncidentReplayHistory.findOneAndUpdate(
        filter,
        {
            $set: {
                feedback: {
                    rating,
                    note: String(req.body.note || '').slice(0, 1000),
                    userId: req.userId,
                    createdAt: new Date(),
                },
            },
        },
        { returnDocument: 'after' }
    ).lean();
    if (!updated) {
        return res.status(StatusCodes.NOT_FOUND).json(
            customResponse({
                data: null,
                message: 'Không tìm thấy replay để phản hồi',
                status: StatusCodes.NOT_FOUND,
                success: false,
            })
        );
    }
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeReplayHistory(updated),
            message: 'Đã ghi nhận phản hồi',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updateIncidentReplayWorkflow = async (req: Request, res: Response) => {
    const action = String(req.body.action || '') as ReplayWorkflowAction;
    if (!['review', 'approve', 'close', 'reopen'].includes(action)) {
        return res.status(StatusCodes.BAD_REQUEST).json(
            customResponse({
                data: null,
                message: 'Hành động workflow không hợp lệ',
                status: StatusCodes.BAD_REQUEST,
                success: false,
            })
        );
    }

    const filter: Record<string, any> = { _id: req.params.id, isDeleted: { $ne: true } };
    if (req.userId) filter.createdBy = req.userId;
    const current = await IncidentReplayHistory.findOne(filter).lean();
    if (!current) {
        return res.status(StatusCodes.NOT_FOUND).json(
            customResponse({
                data: null,
                message: 'Không tìm thấy replay để cập nhật workflow',
                status: StatusCodes.NOT_FOUND,
                success: false,
            })
        );
    }
    if (current.workflowStatus === 'closed' && action !== 'reopen') {
        return res.status(StatusCodes.BAD_REQUEST).json(
            customResponse({
                data: null,
                message: 'Hồ sơ đã đóng. Cần mở lại trước khi cập nhật.',
                status: StatusCodes.BAD_REQUEST,
                success: false,
            })
        );
    }

    const actorName = await getActorName(req.userId);
    const now = new Date();
    const note = String(req.body.note || '').trim().slice(0, 3000);
    const conclusion = String(req.body.conclusion || '').trim().slice(0, 3000);
    const update: Record<string, any> = {
        version: Math.max(Number(current.version || 0), 6),
    };
    // Mongoose bỏ qua giá trị undefined trong $set nên muốn xoá field phải dùng $unset
    const unset: Record<string, 1> = {};

    if (action === 'review') {
        update.workflowStatus = 'reviewed';
        update.reviewNote = note;
        update.reviewedBy = req.userId;
        update.reviewedByName = actorName;
        update.reviewedAt = now;
    } else if (action === 'approve') {
        update.workflowStatus = 'approved';
        update.managerConclusion = conclusion || note || current.managerConclusion || current.reviewNote;
        update.approvedBy = req.userId;
        update.approvedByName = actorName;
        update.approvedAt = now;
    } else if (action === 'close') {
        update.workflowStatus = 'closed';
        update.managerConclusion = conclusion || note || current.managerConclusion || current.reviewNote;
        update.closedBy = req.userId;
        update.closedByName = actorName;
        update.closedAt = now;
    } else if (action === 'reopen') {
        update.workflowStatus = 'reviewed';
        unset.closedBy = 1;
        unset.closedByName = 1;
        unset.closedAt = 1;
    }

    const auditAction = action === 'review' ? 'reviewed' : action === 'approve' ? 'approved' : action === 'close' ? 'closed' : 'reopened';
    const updated = await IncidentReplayHistory.findOneAndUpdate(
        filter,
        {
            $set: update,
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
            $push: {
                auditTrail: {
                    action: auditAction,
                    note: note || conclusion,
                    userId: req.userId,
                    userName: actorName,
                    at: now,
                },
            },
        },
        { returnDocument: 'after' }
    ).lean();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeReplayHistory(updated, false),
            message: 'Đã cập nhật workflow Incident Replay',
            status: StatusCodes.OK,
            success: true,
        })
    );
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

type ReplayScope = {
    applied: boolean;
    plantIds: string[];
    plantNames: string[];
    supplierTerms: string[];
    supplierIds: string[];
    materialTerms: string[];
    materialIds: string[];
    assetTerms: string[];
    assetIds: string[];
    notes: string[];
};

type ReplayConversationContext = {
    scope?: ReplayScope;
    periodDays?: number;
    focus?: ReplayDomain;
    question?: string;
    updatedAt: number;
};

type ReplayBreakdownRow = {
    label: string;
    value: number;
    count: number;
    sharePct: number;
    previousValue: number;
    delta: number;
    deltaPct: number;
};

type ReplayBreakdown = {
    key: string;
    title: string;
    domain: ReplayDomain;
    total: number;
    rows: ReplayBreakdownRow[];
};

type ReplayAnomaly = {
    title: string;
    severity: ReplaySeverity;
    score: number;
    description: string;
    evidence: string[];
    domain: ReplayDomain;
};

type ReplayFacts = {
    purchaseValue: number;
    purchaseCount: number;
    distributionValue: number;
    distributionCount: number;
    maintenanceCost: number;
    maintenanceCount: number;
    pendingRequests: number;
    overdueMaintenances: number;
    driverMap: Map<string, ReplayDriver>;
    events: ReplayEvent[];
};

const money = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
};

const replayContextStore = new Map<string, ReplayConversationContext>();
const CONTEXT_TTL_MS = 30 * 60 * 1000;

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

const buildExplicitRange = (start: Date, end: Date) => {
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    const prevEnd = endOfDay(subDays(start, 1));
    const prevStart = startOfDay(subDays(prevEnd, days - 1));
    return { start: startOfDay(start), end: endOfDay(end), prevStart, prevEnd, days };
};

const parseNaturalRange = (question: string, fallbackDays: number) => {
    const q = normalize(question);
    const now = new Date();
    const monthMatch = q.match(/thang\s*(\d{1,2})(?:\s*\/\s*(\d{4}))?/);
    if (monthMatch) {
        const month = Math.min(Math.max(Number(monthMatch[1]), 1), 12);
        const year = Number(monthMatch[2]) || now.getFullYear();
        return buildExplicitRange(new Date(year, month - 1, 1), new Date(year, month, 0));
    }
    const quarterMatch = q.match(/q(?:uy)?\s*(\d)|quy\s*(\d)/);
    if (quarterMatch) {
        const quarter = Math.min(Math.max(Number(quarterMatch[1] || quarterMatch[2]), 1), 4);
        const startMonth = (quarter - 1) * 3;
        return buildExplicitRange(new Date(now.getFullYear(), startMonth, 1), new Date(now.getFullYear(), startMonth + 3, 0));
    }
    const daysMatch = q.match(/(\d{1,3})\s*ngay/);
    if (daysMatch) return { ...buildRange(clampDays(daysMatch[1])), days: clampDays(daysMatch[1]) };
    if (q.includes('tuan truoc')) {
        const end = endOfDay(subDays(now, now.getDay() || 7));
        const start = startOfDay(subDays(end, 6));
        return buildExplicitRange(start, end);
    }
    if (q.includes('tuan nay')) {
        const day = now.getDay() || 7;
        return buildExplicitRange(startOfDay(subDays(now, day - 1)), now);
    }
    if (q.includes('thang truoc')) {
        return buildExplicitRange(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0));
    }
    if (q.includes('thang nay')) {
        return buildExplicitRange(new Date(now.getFullYear(), now.getMonth(), 1), now);
    }
    return { ...buildRange(fallbackDays), days: fallbackDays };
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

// Từ mở đầu là động/tính/hư từ => cụm bắt được là mô tả biến động ("tăng mạnh", "đột biến"...),
// không phải tên thực thể. Nếu dùng làm filter sẽ loại sạch dữ liệu và mọi chỉ số về 0.
const STOP_LEAD_TOKENS = new Set([
    'tang', 'giam', 'cao', 'thap', 'nhieu', 'it', 'lon', 'nho', 'dot', 'bien', 'bat', 'thuong',
    'chenh', 'lech', 'thay', 'doi', 'phat', 'sinh', 'deu', 'van', 'dang', 'da', 'se', 'bi', 'duoc',
    'la', 'co', 'khong', 'chua', 'sao', 'nao', 'gi', 'the', 'nhu', 'hon', 'qua', 'cua', 'va', 'hay',
    'hoac', 'thi', 'ma', 'o', 'den', 'tu', 've', 'theo', 'voi', 'xem', 'giai', 'thich', 'phan',
    'tich', 'kiem', 'tra', 'trong', 'ngoai', 'gan', 'xa', 'nay', 'kia', 'do', 'di', 'len', 'xuong',
    'manh', 'nhanh', 'cham', 'som', 'muon', 'tot', 'xau', 'sai', 'dung', 'vi', 'tai',
]);

const isNoiseTerm = (term: string) => {
    const first = normalize(term).split(' ')[0] || '';
    return !first || STOP_LEAD_TOKENS.has(first);
};

const extractTermsAfter = (question: string, keys: string[]) => {
    const terms = new Set<string>();
    for (const key of keys) {
        const rx = new RegExp(`${key}\\s*[:：]?\\s*["']?([^"',;\\n]{2,48})`, 'i');
        const hit = question.match(rx)?.[1]?.trim();
        if (!hit) continue;
        const cleaned = hit.replace(/\b(trong|gan|gần|ky|kỳ|nay|thang|tháng|tuan|tuần|co|có|khong|không)\b.*$/i, '').trim();
        if (cleaned && !isNoiseTerm(cleaned)) terms.add(cleaned);
    }
    // Cụm trong ngoặc kép là người dùng chỉ định tường minh -> giữ nguyên, không lọc stopword
    const quoted = question.match(/"([^"]{2,60})"|'([^']{2,60})'/g) || [];
    quoted.forEach((raw) => terms.add(raw.replace(/^["']|["']$/g, '').trim()));
    return [...terms].filter((t) => t.length >= 2);
};

const extractScope = (question: string, plants: any[]): ReplayScope => {
    const q = normalize(question);
    const plantMatches = plants.filter((plant: any) => {
        const name = normalize(String(plant.name || plant.code || ''));
        const code = normalize(String(plant.code || ''));
        return (name && q.includes(name)) || (code && q.includes(code));
    });
    const supplierTerms = extractTermsAfter(question, ['ncc', 'nhà cung cấp', 'nha cung cap', 'supplier']);
    // Không dùng key "hàng": quá phổ biến ("mua hàng tăng..."), bắt nhầm cụm mô tả làm tên vật tư
    const materialTerms = extractTermsAfter(question, ['vật tư', 'vat tu', 'material']);
    // Mã máy/serial: bắt buộc VIẾT HOA và có chữ số — bỏ cờ `i` kẻo từ thường ("trong") thành serial
    const assetTerms = [
        ...new Set(
            (question.match(/\b[A-Z0-9][A-Z0-9._-]{4,}\b/g) || []).filter((s) => /\d/.test(s)).map((s) => s.trim())
        ),
    ];
    const notes: string[] = [];
    if (plantMatches.length) notes.push(`Lọc theo cơ sở: ${plantMatches.map((p: any) => p.name || p.code).join(', ')}`);
    if (supplierTerms.length) notes.push(`Lọc theo NCC/từ khóa: ${supplierTerms.join(', ')}`);
    if (materialTerms.length) notes.push(`Lọc theo vật tư/từ khóa: ${materialTerms.join(', ')}`);
    if (assetTerms.length) notes.push(`Lọc theo mã/serial: ${assetTerms.join(', ')}`);
    return {
        applied: !!(plantMatches.length || supplierTerms.length || materialTerms.length || assetTerms.length),
        plantIds: plantMatches.map((p: any) => String(p._id)),
        plantNames: plantMatches.map((p: any) => String(p.name || p.code || '')),
        supplierTerms,
        supplierIds: [],
        materialTerms,
        materialIds: [],
        assetTerms,
        assetIds: [],
        notes,
    };
};

const matchTerm = (value: unknown, terms: string[]) => {
    if (!terms.length) return true;
    const text = normalize(String(value || ''));
    return terms.some((term) => {
        const t = normalize(term);
        return text.includes(t) || t.includes(text);
    });
};

const matchPlant = (scope: ReplayScope, value?: unknown, name?: unknown) => {
    if (!scope.plantIds.length && !scope.plantNames.length) return true;
    const id = value ? String(value) : '';
    const n = normalize(String(name || ''));
    return scope.plantIds.includes(id) || scope.plantNames.some((plantName) => n.includes(normalize(plantName)));
};

const matchAssetTerms = (scope: ReplayScope, values: unknown[]) => {
    if (!scope.assetTerms.length) return true;
    const haystack = normalize(values.filter(Boolean).join(' '));
    return scope.assetTerms.some((term) => haystack.includes(normalize(term)));
};

const matchMaterial = (scope: ReplayScope, item: any) => {
    if (!scope.materialIds.length && !scope.materialTerms.length) return true;
    return (item?.materialId && scope.materialIds.includes(String(item.materialId))) || matchTerm(item?.materialName, scope.materialTerms);
};

const matchSupplier = (scope: ReplayScope, item: any, fallbackName?: unknown, fallbackId?: unknown) => {
    if (!scope.supplierIds.length && !scope.supplierTerms.length) return true;
    return (
        (item?.supplierId && scope.supplierIds.includes(String(item.supplierId))) ||
        (fallbackId && scope.supplierIds.includes(String(fallbackId))) ||
        matchTerm(item?.supplierName || fallbackName, scope.supplierTerms)
    );
};

const matchAssetEntity = (scope: ReplayScope, assetIds: unknown[], values: unknown[]) => {
    if (!scope.assetIds.length && !scope.assetTerms.length) return true;
    return assetIds.some((id) => id && scope.assetIds.includes(String(id))) || matchAssetTerms(scope, values);
};

const similarity = (query: string, target: string) => {
    const q = normalize(query);
    const t = normalize(target);
    if (!q || !t) return 0;
    if (q === t) return 100;
    if (t.includes(q) || q.includes(t)) return 86;
    const qTokens = q.split(' ').filter(Boolean);
    const tTokens = new Set(t.split(' ').filter(Boolean));
    const hit = qTokens.filter((token) => tTokens.has(token) || [...tTokens].some((x) => x.includes(token) || token.includes(x))).length;
    return qTokens.length ? Math.round((hit / qTokens.length) * 78) : 0;
};

const bestMatches = <T extends Record<string, any>>(terms: string[], rows: T[], pick: (row: T) => string[], minScore = 64) => {
    const matches: T[] = [];
    for (const term of terms) {
        const ranked = rows
            .map((row) => ({ row, score: Math.max(...pick(row).map((value) => similarity(term, value))) }))
            .filter((x) => x.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
        ranked.forEach((x) => matches.push(x.row));
    }
    return [...new Map(matches.map((row) => [String(row._id), row])).values()];
};

const loadEntityCatalog = async () => {
    const [materials, suppliers, assets] = await Promise.all([
        Material.find({ isDeleted: { $ne: true }, isActive: { $ne: false } }).select('_id name code category').limit(3000).lean(),
        Supplier.find({ isDeleted: { $ne: true }, isActive: { $ne: false } }).select('_id name code contactName').limit(1000).lean(),
        Asset.find({ isDeleted: { $ne: true } }).select('_id machineCode serial name type model area plantId').limit(5000).lean(),
    ]);
    return { materials, suppliers, assets };
};

const mergeScope = (base: ReplayScope, previous?: ReplayScope): ReplayScope => {
    if (!previous) return base;
    const uniq = <T>(arr: T[]) => [...new Set(arr.filter(Boolean))];
    return {
        applied: base.applied || previous.applied,
        plantIds: base.plantIds.length ? base.plantIds : previous.plantIds,
        plantNames: base.plantNames.length ? base.plantNames : previous.plantNames,
        supplierTerms: uniq([...previous.supplierTerms, ...base.supplierTerms]),
        supplierIds: uniq([...previous.supplierIds, ...base.supplierIds]),
        materialTerms: uniq([...previous.materialTerms, ...base.materialTerms]),
        materialIds: uniq([...previous.materialIds, ...base.materialIds]),
        assetTerms: uniq([...previous.assetTerms, ...base.assetTerms]),
        assetIds: uniq([...previous.assetIds, ...base.assetIds]),
        notes: uniq([...previous.notes, ...base.notes]),
    };
};

const resolveScopeEntities = async (scope: ReplayScope, question: string, plants: any[]) => {
    const q = normalize(question);
    const catalog = await loadEntityCatalog();
    const aliasPlantMatches = plants.filter((plant: any) => {
        const code = normalize(String(plant.code || ''));
        const name = normalize(String(plant.name || ''));
        const number = name.match(/co so\s*(\d+)/)?.[1] || code.match(/cs\s*(\d+)/)?.[1];
        return number && (q.includes(`cs${number}`) || q.includes(`cs ${number}`) || q.includes(`co so ${number}`));
    });
    aliasPlantMatches.forEach((plant: any) => {
        if (!scope.plantIds.includes(String(plant._id))) scope.plantIds.push(String(plant._id));
        if (!scope.plantNames.includes(String(plant.name || plant.code))) scope.plantNames.push(String(plant.name || plant.code));
    });

    const materialCandidates = [...scope.materialTerms, ...extractTermsAfter(question, ['mực', 'kim', 'chỉ', 'dầu', 'keo', 'giấy'])];
    const materialMatches = bestMatches(materialCandidates, catalog.materials as any[], (row) => [row.name, row.code, row.category].filter(Boolean));
    materialMatches.forEach((m: any) => {
        if (!scope.materialIds.includes(String(m._id))) scope.materialIds.push(String(m._id));
        if (!scope.materialTerms.includes(m.name)) scope.materialTerms.push(m.name);
    });

    const supplierMatches = bestMatches(scope.supplierTerms, catalog.suppliers as any[], (row) => [row.name, row.code, row.contactName].filter(Boolean));
    supplierMatches.forEach((s: any) => {
        if (!scope.supplierIds.includes(String(s._id))) scope.supplierIds.push(String(s._id));
        if (!scope.supplierTerms.includes(s.name)) scope.supplierTerms.push(s.name);
    });

    const assetMatches = bestMatches(scope.assetTerms, catalog.assets as any[], (row) => [row.machineCode, row.serial, row.name, row.type, row.model, row.area].filter(Boolean), 58);
    assetMatches.forEach((a: any) => {
        if (!scope.assetIds.includes(String(a._id))) scope.assetIds.push(String(a._id));
        if (a.machineCode && !scope.assetTerms.includes(a.machineCode)) scope.assetTerms.push(a.machineCode);
        if (a.serial && !scope.assetTerms.includes(a.serial)) scope.assetTerms.push(a.serial);
    });

    scope.applied = !!(scope.plantIds.length || scope.supplierTerms.length || scope.materialTerms.length || scope.assetTerms.length);
    scope.notes = [
        ...(scope.plantNames.length ? [`Lọc theo cơ sở: ${scope.plantNames.join(', ')}`] : []),
        ...(scope.supplierTerms.length ? [`Lọc theo NCC/từ khóa: ${scope.supplierTerms.slice(0, 5).join(', ')}`] : []),
        ...(scope.materialTerms.length ? [`Lọc theo vật tư/từ khóa: ${scope.materialTerms.slice(0, 5).join(', ')}`] : []),
        ...(scope.assetTerms.length ? [`Lọc theo mã/serial: ${scope.assetTerms.slice(0, 5).join(', ')}`] : []),
    ];
    return scope;
};

const collectReplayFacts = async (
    start: Date,
    end: Date,
    scope: ReplayScope,
    plantNames: Map<string, string>,
    includeEvents: boolean
): Promise<ReplayFacts> => {
    const facts: ReplayFacts = {
        purchaseValue: 0,
        purchaseCount: 0,
        distributionValue: 0,
        distributionCount: 0,
        maintenanceCost: 0,
        maintenanceCount: 0,
        pendingRequests: 0,
        overdueMaintenances: 0,
        driverMap: new Map<string, ReplayDriver>(),
        events: [],
    };

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
            .lean(),
        Maintenance.find({ isDeleted: { $ne: true }, startDate: dateInRange(start, end) })
            .populate('assetId', 'machineCode serial name type plantId area')
            .populate('assetIds', 'machineCode serial name type plantId area')
            .sort({ startDate: -1 })
            .lean(),
        PurchaseRequest.find({
            isDeleted: { $ne: true },
            requestType: { $in: ['purchase', 'supply_request', 'technical_purchase'] },
            createdAt: dateInRange(start, end),
        })
            .sort({ createdAt: -1 })
            .lean(),
    ]);

    for (const order of purchaseOrders as any[]) {
        // Mỗi đơn chỉ thuộc đúng 1 kỳ theo mốc hiệu lực, tránh đơn tạo kỳ trước + nhận kỳ này bị đếm cả 2 kỳ
        const orderAt = new Date(order.receivedAt || order.orderedAt || order.createdAt);
        if (Number.isNaN(orderAt.getTime()) || orderAt < start || orderAt > end) continue;
        const matchedItems = (order.items || []).filter((item: any) => {
            const materialOk = matchMaterial(scope, item);
            const supplierOk = matchSupplier(scope, item, order.supplierName, order.supplierId);
            const plantOk = matchPlant(scope, item.plantId || order.plantId, item.plantName);
            return materialOk && supplierOk && plantOk;
        });
        if (!matchedItems.length && scope.applied) continue;
        const items = scope.applied ? matchedItems : order.items || [];
        const value = items.reduce((sum: number, item: any) => {
            const v = itemValue(item);
            pushDriver(facts.driverMap, item.materialName || 'Vật tư mua chưa rõ tên', v, 'purchase', order.orderCode);
            if (item.supplierName || order.supplierName) pushDriver(facts.driverMap, `NCC: ${item.supplierName || order.supplierName}`, v, 'purchase', order.orderCode);
            if (item.plantName || item.plantId || order.plantId) {
                pushDriver(facts.driverMap, `Cơ sở mua: ${item.plantName || plantNames.get(String(item.plantId || order.plantId))}`, v, 'purchase', order.orderCode);
            }
            return sum + v;
        }, 0);
        facts.purchaseValue += value;
        facts.purchaseCount += 1;
        if (includeEvents) {
            facts.events.push({
                id: String(order._id),
                type: 'purchase',
                at: iso(order.receivedAt || order.orderedAt || order.createdAt),
                title: `Đơn mua ${order.orderCode || '-'}`,
                subtitle: `${order.supplierName || 'Chưa rõ NCC'} · ${order.status || '-'}`,
                value: round0(value),
                severity: eventValueSeverity(value),
                route: '/materials/purchase-orders',
                evidence: items.slice(0, 4).map((it: any) => `${it.materialName || 'Vật tư'}: ${money(it.quantityOrdered).toLocaleString('vi-VN')} ${it.unit || ''}`),
            });
        }
    }

    for (const record of distributions as any[]) {
        const recordAt = new Date(record.distributedAt || record.confirmedAt || record.createdAt);
        if (Number.isNaN(recordAt.getTime()) || recordAt < start || recordAt > end) continue;
        if (!matchPlant(scope, record.toPlantId || record.fromPlantId, plantNames.get(String(record.toPlantId)) || plantNames.get(String(record.fromPlantId)))) continue;
        const matchedItems = (record.items || []).filter((item: any) => matchMaterial(scope, item));
        if (!matchedItems.length && (scope.materialTerms.length || scope.supplierTerms.length)) continue;
        const items = scope.materialTerms.length ? matchedItems : record.items || [];
        const value = items.reduce((sum: number, item: any) => {
            const v = itemValue(item);
            pushDriver(facts.driverMap, item.materialName || 'Vật tư cấp phát chưa rõ tên', v, 'distribution', record.distributionCode);
            pushDriver(facts.driverMap, `Cơ sở nhận: ${plantNames.get(String(record.toPlantId)) || 'Chưa rõ'}`, v, 'distribution', record.distributionCode);
            return sum + v;
        }, 0);
        facts.distributionValue += value;
        facts.distributionCount += 1;
        if (includeEvents) {
            const toPlant = plantNames.get(String(record.toPlantId)) || 'Chưa rõ nơi nhận';
            facts.events.push({
                id: String(record._id),
                type: 'distribution',
                at: iso(record.distributedAt || record.confirmedAt || record.createdAt),
                title: `Phiếu cấp phát ${record.distributionCode || '-'}`,
                subtitle: `${toPlant} · ${record.status || '-'}`,
                value: round0(value),
                severity: eventValueSeverity(value),
                route: '/materials/distributions',
                evidence: items.slice(0, 4).map((it: any) => `${it.materialName || 'Vật tư'}: ${money(it.quantityDistributed ?? it.quantity).toLocaleString('vi-VN')} ${it.unit || ''}`),
            });
        }
    }

    for (const mt of maintenances as any[]) {
        const asset = mt.assetId && typeof mt.assetId === 'object' ? mt.assetId : undefined;
        const assets = Array.isArray(mt.assetIds) ? mt.assetIds.filter((a: any) => a && typeof a === 'object') : [];
        const assetValues = [asset, ...assets].flatMap((a: any) => [a?.machineCode, a?.serial, a?.name, a?.type, a?.area]);
        if (!matchPlant(scope, mt.plantId || asset?.plantId, mt.plantName) || !matchAssetEntity(scope, [mt.assetId?._id || mt.assetId, ...(assets || []).map((a: any) => a._id)], assetValues)) continue;
        const value = money(mt.externalRepair?.actualCost ?? mt.cost);
        const assetCodes = assets.map((a: any) => a.machineCode || a.name).filter(Boolean);
        pushDriver(facts.driverMap, `Bảo trì: ${mt.repairMode === 'external' ? 'sửa ngoài' : 'nội bộ'}`, value || 1, 'maintenance', mt.description);
        if (mt.plantName || mt.plantId) pushDriver(facts.driverMap, `Cơ sở bảo trì: ${mt.plantName || plantNames.get(String(mt.plantId))}`, value || 1, 'maintenance');
        facts.maintenanceCost += value;
        facts.maintenanceCount += 1;
        if (mt.status === 'overdue') facts.overdueMaintenances += 1;
        if (includeEvents) {
            facts.events.push({
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
    }

    for (const request of requests as any[]) {
        if (!matchPlant(scope, request.plantId || request.toPlantId || request.fromPlantId, request.plantName)) continue;
        const matchedItems = (request.items || []).filter((item: any) => matchMaterial(scope, item));
        if (!matchedItems.length && scope.materialTerms.length) continue;
        const items = scope.materialTerms.length ? matchedItems : request.items || [];
        if (['draft', 'pending'].includes(request.status)) facts.pendingRequests += 1;
        if (includeEvents) {
            const value = money(request.totalWithVat || request.totalActual || request.totalEstimated);
            facts.events.push({
                id: String(request._id),
                type: request.requestType === 'supply_request' ? 'distribution' : 'purchase',
                at: iso(request.createdAt),
                title: `Đề xuất ${request.requestCode || '-'}`,
                subtitle: `${request.requestType || '-'} · ${request.status || '-'} · ${items.length} dòng`,
                value: round0(value),
                severity: ['pending', 'draft'].includes(request.status) ? 'warning' : 'info',
                route: request.requestType === 'supply_request' ? '/materials/supply-requests' : '/materials/purchase-requests',
                evidence: items.slice(0, 4).map((it: any) => `${it.materialName || 'Vật tư'}: ${money(it.quantityRequested).toLocaleString('vi-VN')} ${it.unit || ''}`),
            });
        }
    }

    facts.purchaseValue = round0(facts.purchaseValue);
    facts.distributionValue = round0(facts.distributionValue);
    facts.maintenanceCost = round0(facts.maintenanceCost);
    return facts;
};

const buildDrivers = (driverMap: Map<string, ReplayDriver>) =>
    [...driverMap.values()]
        .map((d) => ({ ...d, value: round0(d.value) }))
        .filter((d) => d.value > 0 || d.count > 0)
        .sort((a, b) => b.value - a.value);

const buildBreakdowns = (current: ReplayDriver[], previous: ReplayDriver[]) => {
    const prevByLabel = new Map(previous.map((d) => [d.label, d]));
    const groups = new Map<ReplayDomain, ReplayDriver[]>();
    current.forEach((driver) => {
        const rows = groups.get(driver.domain) || [];
        rows.push(driver);
        groups.set(driver.domain, rows);
    });
    return [...groups.entries()]
        .map(([domain, drivers]) => {
            const total = drivers.reduce((sum, driver) => sum + driver.value, 0);
            const rows: ReplayBreakdownRow[] = drivers.slice(0, 10).map((driver) => {
                const previousValue = prevByLabel.get(driver.label)?.value || 0;
                const delta = driver.value - previousValue;
                return {
                    label: driver.label,
                    value: driver.value,
                    count: driver.count,
                    sharePct: total > 0 ? Math.round((driver.value / total) * 100) : 0,
                    previousValue,
                    delta,
                    deltaPct: pct(driver.value, previousValue),
                };
            });
            return {
                key: `${domain}-drivers`,
                title:
                    domain === 'purchase'
                        ? 'Breakdown mua hàng'
                        : domain === 'distribution'
                          ? 'Breakdown cấp phát'
                          : domain === 'maintenance'
                            ? 'Breakdown bảo trì'
                            : 'Breakdown khác',
                domain,
                total: round0(total),
                rows,
            };
        })
        .filter((group) => group.rows.length)
        .sort((a, b) => b.total - a.total);
};

const buildAnomalies = (
    metrics: ReplayMetric[],
    drivers: ReplayDriver[],
    previousDrivers: ReplayDriver[],
    events: ReplayEvent[],
    flags: string[]
) => {
    const anomalies: ReplayAnomaly[] = [];
    const prevByLabel = new Map(previousDrivers.map((d) => [d.label, d]));

    metrics.forEach((metric) => {
        if (metric.current > 0 && metric.deltaPct >= 50) {
            anomalies.push({
                title: `${metric.label} tăng mạnh`,
                severity: metric.deltaPct >= 100 ? 'danger' : 'warning',
                score: Math.min(100, 45 + Math.min(metric.deltaPct, 120) / 2),
                description: `${metric.label} kỳ này ${round0(metric.current).toLocaleString('vi-VN')}${metric.unit === 'vnd' ? 'đ' : ''}, kỳ trước ${round0(metric.previous).toLocaleString('vi-VN')}${metric.unit === 'vnd' ? 'đ' : ''}.`,
                evidence: [`Chênh lệch ${round0(metric.delta).toLocaleString('vi-VN')}${metric.unit === 'vnd' ? 'đ' : ''}`, `Tỷ lệ tăng ${metric.deltaPct}%`],
                domain:
                    metric.key === 'purchase_value'
                        ? 'purchase'
                        : metric.key === 'distribution_value'
                          ? 'distribution'
                          : metric.key.startsWith('maintenance')
                            ? 'maintenance'
                            : 'mixed',
            });
        }
    });

    drivers.slice(0, 8).forEach((driver) => {
        const previous = prevByLabel.get(driver.label)?.value || 0;
        const deltaPct = pct(driver.value, previous);
        const relatedEvent = events.find((e) => e.type === driver.domain);
        if (driver.value >= 5_000_000 && deltaPct >= 50) {
            anomalies.push({
                title: `${driver.label} là tác nhân đột biến`,
                severity: driver.value >= 20_000_000 || deltaPct >= 100 ? 'danger' : 'warning',
                score: Math.min(100, 40 + Math.min(deltaPct, 120) / 2 + Math.min(driver.value / 1_000_000, 20)),
                description: `Kỳ này ${round0(driver.value).toLocaleString('vi-VN')}đ, kỳ trước ${round0(previous).toLocaleString('vi-VN')}đ.`,
                evidence: [relatedEvent ? `${dateLabel(relatedEvent.at)} · ${relatedEvent.title}` : `${driver.count} dòng/sự kiện`, `Tăng ${deltaPct}% so với kỳ trước`],
                domain: driver.domain,
            });
        }
    });

    flags.slice(0, 3).forEach((flag) => {
        anomalies.push({
            title: 'Cảnh báo nghiệp vụ',
            severity: 'warning',
            score: 55,
            description: flag,
            evidence: [flag],
            domain: 'mixed',
        });
    });

    return anomalies.sort((a, b) => b.score - a.score).slice(0, 10);
};

const buildAiNarrative = async (payload: {
    question: string;
    periodLabel: string;
    focus: ReplayDomain;
    scope?: ReplayScope;
    caseScore: number;
    caseSeverity: ReplayCaseSeverity;
    metrics: ReplayMetric[];
    drivers: ReplayDriver[];
    anomalies?: ReplayAnomaly[];
    breakdowns?: ReplayBreakdown[];
    rootCauseChains: ReplayRootCauseChain[];
    recommendations: ReplayRecommendation[];
    events: ReplayEvent[];
    flags: string[];
    feedbackLessons?: {
        question?: string;
        focus?: string;
        period?: string;
        rating?: string;
        note?: string;
        flags?: string[];
        previousAnswer?: string;
    }[];
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
                        'Bạn là trợ lý điều tra vận hành cho công ty may. Chỉ phân tích dựa trên JSON được cung cấp. Không bịa số liệu. Mọi giá trị tiền trong JSON đã tính bằng VND (đồng), KHÔNG phải triệu hay tỷ — khi diễn giải sang "triệu đồng"/"tỷ đồng" phải chia đúng 1.000.000/1.000.000.000, ví dụ 33101280 là 33,1 triệu đồng chứ không phải 33,1 tỷ đồng; nếu không chắc đơn vị thì cứ ghi nguyên số kèm "đ". Nếu có feedbackLessons, dùng chúng như bài học để tránh lặp lỗi: không kết luận quá chắc khi thiếu dữ liệu, không bỏ sót phạm vi người dùng hỏi, luôn nêu bằng chứng. Trả lời tiếng Việt, ngắn, có nguyên nhân chính, bằng chứng và hành động đề xuất.',
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        question: payload.question,
                        period: payload.periodLabel,
                        focus: payload.focus,
                        scope: payload.scope,
                        caseScore: payload.caseScore,
                        caseSeverity: payload.caseSeverity,
                        metrics: payload.metrics,
                        anomalies: (payload.anomalies || []).slice(0, 6),
                        breakdowns: (payload.breakdowns || []).slice(0, 4),
                        rootCauseChains: payload.rootCauseChains.slice(0, 5),
                        recommendations: payload.recommendations,
                        topDrivers: payload.drivers.slice(0, 8),
                        timeline: payload.events.slice(0, 12),
                        flags: payload.flags,
                        feedbackLessons: (payload.feedbackLessons || []).slice(0, 5),
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

// Bản V6 (scope + so kỳ + lưu lịch sử) là bản duy nhất đang chạy
export const runIncidentReplay = runIncidentReplayV2;
