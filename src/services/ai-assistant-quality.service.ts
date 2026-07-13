import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import config from '@/config/env.config';
import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import AiAssistantTrace from '@/models/AiAssistantTrace';
import { runAssistant } from '@/services/ai-agent.service';
import type { AssistantContext } from '@/services/ai/assistant-policy.service';
import customResponse from '@/utils/response';

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const percentile = (values: number[], percent: number) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((percent / 100) * sorted.length))];
};

const availableReplayModels = () => {
    const models = new Set<string>();
    Object.values(config.ai.featureModels || {}).forEach((value) => {
        if (Array.isArray(value)) value.forEach((model) => model && models.add(model));
        else if (value) models.add(value);
    });
    if (config.ai.defaultModel) models.add(config.ai.defaultModel);
    if (config.ai.jsonModel) models.add(config.ai.jsonModel);
    return [...models];
};

const startOfRange = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const assistantReqId = (value: unknown) => {
    const reqId = String(value || '').trim();
    if (!/^ai_[a-z0-9]+_[a-z0-9]{3,12}$/i.test(reqId)) throw new BadRequestError('reqId trợ lý không hợp lệ');
    return reqId;
};

export const submitAssistantFeedback = async (req: Request, res: Response) => {
    const trace = await AiAssistantTrace.findOne({ reqId: assistantReqId(req.params.reqId), userId: req.userId });
    if (!trace) throw new NotFoundError('Không tìm thấy câu trả lời để đánh giá');

    trace.set('feedback', {
        rating: req.body.rating,
        reason: req.body.rating === 'not_helpful' ? req.body.reason : undefined,
        note: req.body.note,
        userId: req.userId,
        createdAt: new Date(),
    });
    await trace.save();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { reqId: trace.reqId, feedback: trace.get('feedback') },
            message: 'Đã ghi nhận đánh giá trợ lý',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getAssistantQualityOverview = async (req: Request, res: Response) => {
    const days = clampInt(req.query.days, 7, 1, 90);
    const from = startOfRange(days);
    const match = { createdAt: { $gte: from } };

    const [summaryRows, latencyRows, daily, providers, models, tools, feedbackReasons, recentIssues] =
        await Promise.all([
            AiAssistantTrace.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
                        fallback: { $sum: { $cond: [{ $eq: ['$status', 'fallback'] }, 1, 0] } },
                        policy: { $sum: { $cond: [{ $eq: ['$status', 'policy'] }, 1, 0] } },
                        error: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                        trusted: { $sum: { $cond: [{ $eq: ['$confidence', 'high'] }, 1, 0] } },
                        verified: { $sum: { $cond: [{ $eq: ['$grounding', 'verified'] }, 1, 0] } },
                        corrected: { $sum: { $cond: [{ $eq: ['$grounding', 'corrected'] }, 1, 0] } },
                        unverified: { $sum: { $cond: [{ $eq: ['$grounding', 'unverified'] }, 1, 0] } },
                        feedbackCount: { $sum: { $cond: [{ $ne: ['$feedback', null] }, 1, 0] } },
                        helpful: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'helpful'] }, 1, 0] } },
                        notHelpful: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'not_helpful'] }, 1, 0] } },
                        avgLatencyMs: { $avg: '$tookMs' },
                        avgToolCalls: { $avg: '$toolCallCount' },
                        failedToolCalls: { $sum: '$failedToolCount' },
                    },
                },
            ]),
            AiAssistantTrace.find(match).select('tookMs').sort({ createdAt: -1 }).limit(10000).lean(),
            AiAssistantTrace.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Ho_Chi_Minh' },
                        },
                        total: { $sum: 1 },
                        fallback: { $sum: { $cond: [{ $eq: ['$status', 'fallback'] }, 1, 0] } },
                        unverified: { $sum: { $cond: [{ $eq: ['$grounding', 'unverified'] }, 1, 0] } },
                        notHelpful: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'not_helpful'] }, 1, 0] } },
                        avgLatencyMs: { $avg: '$tookMs' },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            AiAssistantTrace.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { provider: '$provider' },
                        total: { $sum: 1 },
                        avgLatencyMs: { $avg: '$tookMs' },
                        fallback: { $sum: { $cond: [{ $eq: ['$status', 'fallback'] }, 1, 0] } },
                        notHelpful: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'not_helpful'] }, 1, 0] } },
                    },
                },
                { $sort: { total: -1 } },
            ]),
            AiAssistantTrace.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { provider: '$provider', model: '$model' },
                        total: { $sum: 1 },
                        avgLatencyMs: { $avg: '$tookMs' },
                        trusted: { $sum: { $cond: [{ $eq: ['$confidence', 'high'] }, 1, 0] } },
                        notHelpful: { $sum: { $cond: [{ $eq: ['$feedback.rating', 'not_helpful'] }, 1, 0] } },
                    },
                },
                { $sort: { total: -1 } },
                { $limit: 20 },
            ]),
            AiAssistantTrace.aggregate([
                { $match: match },
                { $unwind: '$tools' },
                {
                    $group: {
                        _id: '$tools.tool',
                        calls: { $sum: 1 },
                        errors: { $sum: { $cond: ['$tools.success', 0, 1] } },
                        avgDurationMs: { $avg: '$tools.durationMs' },
                        maxDurationMs: { $max: '$tools.durationMs' },
                    },
                },
                { $sort: { calls: -1 } },
            ]),
            AiAssistantTrace.aggregate([
                { $match: { ...match, 'feedback.rating': 'not_helpful' } },
                { $group: { _id: '$feedback.reason', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]),
            AiAssistantTrace.find({
                ...match,
                $or: [
                    { status: { $in: ['fallback', 'error'] } },
                    { grounding: 'unverified' },
                    { 'feedback.rating': 'not_helpful' },
                ],
            })
                .select(
                    'reqId question status provider model grounding confidence tookMs tools feedback createdAt userId'
                )
                .populate('userId', 'name email')
                .sort({ createdAt: -1 })
                .limit(12)
                .lean(),
        ]);

    const raw = summaryRows[0] || {};
    const total = Number(raw.total || 0);
    const feedbackCount = Number(raw.feedbackCount || 0);
    const latencies = latencyRows.map((row: any) => Number(row.tookMs || 0));
    const rate = (value: unknown, denominator = total) =>
        denominator ? Math.round((Number(value || 0) / denominator) * 1000) / 10 : 0;
    const successRate = rate(raw.success);
    const trustedRate = rate(raw.trusted);
    const helpfulRate = rate(raw.helpful, feedbackCount);
    const latencyScore = total
        ? Math.max(0, Math.min(100, 100 - Math.max(0, percentile(latencies, 95) - 10000) / 400))
        : 0;
    const healthScore = total
        ? Math.round(
              successRate * 0.35 +
                  trustedRate * 0.3 +
                  (feedbackCount ? helpfulRate : trustedRate) * 0.2 +
                  latencyScore * 0.15
          )
        : 0;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                generatedAt: new Date().toISOString(),
                range: { days, from: from.toISOString() },
                healthScore,
                summary: {
                    total,
                    success: Number(raw.success || 0),
                    fallback: Number(raw.fallback || 0),
                    policy: Number(raw.policy || 0),
                    error: Number(raw.error || 0),
                    verified: Number(raw.verified || 0),
                    corrected: Number(raw.corrected || 0),
                    unverified: Number(raw.unverified || 0),
                    feedbackCount,
                    helpful: Number(raw.helpful || 0),
                    notHelpful: Number(raw.notHelpful || 0),
                    failedToolCalls: Number(raw.failedToolCalls || 0),
                    successRate,
                    trustedRate,
                    helpfulRate,
                    feedbackRate: rate(feedbackCount),
                    fallbackRate: rate(raw.fallback),
                    avgLatencyMs: Math.round(Number(raw.avgLatencyMs || 0)),
                    p50LatencyMs: percentile(latencies, 50),
                    p95LatencyMs: percentile(latencies, 95),
                    avgToolCalls: Math.round(Number(raw.avgToolCalls || 0) * 10) / 10,
                },
                daily: daily.map((row: any) => ({ date: row._id, ...row, _id: undefined })),
                providers: providers.map((row: any) => ({
                    provider: row._id?.provider || 'unknown',
                    ...row,
                    _id: undefined,
                })),
                models: models.map((row: any) => ({ ...row._id, ...row, _id: undefined })),
                tools: tools.map((row: any) => ({ tool: row._id, ...row, _id: undefined })),
                feedbackReasons: feedbackReasons.map((row: any) => ({ reason: row._id || 'other', count: row.count })),
                recentIssues,
                availableReplayModels: availableReplayModels(),
            },
            message: 'Lấy dashboard chất lượng trợ lý thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const listAssistantTraces = async (req: Request, res: Response) => {
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 20, 5, 50);
    const days = clampInt(req.query.days, 7, 1, 90);
    const filter: Record<string, any> = { createdAt: { $gte: startOfRange(days) } };
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.provider) filter.provider = String(req.query.provider);
    if (req.query.grounding) filter.grounding = String(req.query.grounding);
    if (req.query.feedback === 'helpful' || req.query.feedback === 'not_helpful') {
        filter['feedback.rating'] = String(req.query.feedback);
    } else if (req.query.feedback === 'none') {
        filter.feedback = { $exists: false };
    }
    const search = String(req.query.search || '')
        .trim()
        .slice(0, 120);
    if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ reqId: rx }, { question: rx }, { model: rx }];
    }

    const [total, rows] = await Promise.all([
        AiAssistantTrace.countDocuments(filter),
        AiAssistantTrace.find(filter)
            .select(
                'reqId question status tier provider model confidence grounding sourceCount toolCallCount failedToolCount tookMs feedback createdAt userId plantName'
            )
            .populate('userId', 'name email')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
            message: 'Lấy lịch sử trợ lý thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getAssistantTraceDetail = async (req: Request, res: Response) => {
    const trace = await AiAssistantTrace.findOne({ reqId: assistantReqId(req.params.reqId) })
        .populate('userId', 'name email role')
        .lean();
    if (!trace) throw new NotFoundError('Không tìm thấy trace trợ lý');
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: trace,
            message: 'Lấy chi tiết trace thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const replayAssistantTrace = async (req: Request, res: Response) => {
    const trace: any = await AiAssistantTrace.findOne({ reqId: assistantReqId(req.params.reqId) }).lean();
    if (!trace) throw new NotFoundError('Không tìm thấy trace trợ lý');
    const model = req.body.model as string | undefined;
    const availableModels = availableReplayModels();
    if (model && !availableModels.includes(model))
        throw new BadRequestError('Model replay không nằm trong cấu hình cho phép');

    const context: AssistantContext = {
        userId: String(trace.userId),
        role: trace.role as USER_ROLE,
        plantId: trace.plantId ? String(trace.plantId) : undefined,
        plantName: trace.plantName,
        permissions: [],
        canAccessProcurement: Boolean(trace.canAccessProcurement),
    };
    const replayed = await runAssistant([{ role: 'user', content: trace.question }], context, undefined, {
        skipTrace: true,
        parentReqId: trace.reqId,
        modelOverride: model,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                baseline: {
                    reqId: trace.reqId,
                    answer: trace.answerPreview,
                    provider: trace.provider,
                    model: trace.model,
                    grounding: trace.grounding,
                    confidence: trace.confidence,
                    tookMs: trace.tookMs,
                    toolCallCount: trace.toolCallCount,
                },
                replay: replayed,
                comparison: {
                    latencyDeltaMs: Number(replayed.tookMs || 0) - Number(trace.tookMs || 0),
                    sameModel: String(replayed.model || '') === String(trace.model || ''),
                    sameAnswer: String(replayed.answer || '').trim() === String(trace.answerPreview || '').trim(),
                },
            },
            message: 'Replay trợ lý hoàn tất, không ghi dữ liệu nghiệp vụ',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
