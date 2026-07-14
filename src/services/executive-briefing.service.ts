import { createHash } from 'node:crypto';
import { CronJob } from 'cron';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { ROLE_GROUPS } from '@/constant/permissions';
import ExecutiveBriefing from '@/models/ExecutiveBriefing';
import User from '@/models/User';
import { generateGroundedBriefingContent } from '@/services/executive-briefing-ai.service';
import { buildExecutiveBriefingSnapshot } from '@/services/executive-briefing-data.service';
import { BRIEFING_TIME_ZONE, getClosedBriefingPeriod } from '@/services/executive-briefing.helpers';
import { notifyUser } from '@/services/notification.helper';
import type { BriefingPeriodType, BriefingTrigger, ExecutiveBriefingSnapshot } from '@/types/executiveBriefing';
import customResponse from '@/utils/response';

type GenerateOptions = {
    trigger: BriefingTrigger;
    generatedBy?: string;
    forceDataRefresh?: boolean;
    forceNarrative?: boolean;
    notify?: boolean;
};

type BriefingGenerationResult = {
    briefing: any;
    created: boolean;
    changed: boolean;
};

const inFlight = new Map<string, Promise<BriefingGenerationResult>>();
let scheduleStarted = false;
const SNAPSHOT_VERSION = 2;

const periodTypes: BriefingPeriodType[] = ['week', 'month'];

const isPeriodType = (value: unknown): value is BriefingPeriodType => value === 'week' || value === 'month';

const stableSnapshotHash = (snapshot: ExecutiveBriefingSnapshot) =>
    createHash('sha256')
        .update(JSON.stringify({ version: SNAPSHOT_VERSION, snapshot }))
        .digest('hex');

const notifyDirectorsOnce = async (briefingId: string) => {
    const claimed = await ExecutiveBriefing.findOneAndUpdate(
        { _id: briefingId, notifiedAt: { $exists: false } },
        { $set: { notifiedAt: new Date() } },
        { returnDocument: 'after' }
    ).lean();
    if (!claimed) return 0;

    const directors = await User.find({
        role: { $in: [...ROLE_GROUPS.DIRECTOR_UP] },
        isDeleted: { $ne: true },
        isActive: true,
    })
        .select('_id')
        .lean();

    const riskCount = Array.isArray(claimed.risks) ? claimed.risks.length : 0;
    const message = riskCount
        ? `${claimed.periodLabel} đã chốt dữ liệu và có các đầu việc cần Ban giám đốc rà soát.`
        : `${claimed.periodLabel} đã chốt dữ liệu. Chưa ghi nhận cảnh báo ưu tiên cao.`;

    await Promise.all(
        directors.map((director) =>
            notifyUser(String(director._id), 'notify:new', {
                title: `Bản tin ${claimed.periodType === 'week' ? 'tuần' : 'tháng'} đã sẵn sàng`,
                message,
                type: riskCount ? 'warning' : 'info',
                actionType: 'briefing',
                actionId: String(claimed._id),
            })
        )
    );
    return directors.length;
};

const runGeneration = async (
    periodType: BriefingPeriodType,
    options: GenerateOptions
): Promise<BriefingGenerationResult> => {
    const period = getClosedBriefingPeriod(periodType);
    const existing = await ExecutiveBriefing.findOne({ periodType, periodKey: period.periodKey });
    if (existing && existing.snapshotVersion >= SNAPSHOT_VERSION && !options.forceDataRefresh) {
        return { briefing: existing.toObject(), created: false, changed: false };
    }

    const snapshot = await buildExecutiveBriefingSnapshot(period);
    const sourceHash = stableSnapshotHash(snapshot);

    if (
        existing &&
        existing.sourceHash === sourceHash &&
        !(options.forceNarrative && existing.generationStatus === 'degraded')
    ) {
        return { briefing: existing.toObject(), created: false, changed: false };
    }

    const generated = await generateGroundedBriefingContent(period, snapshot);
    const update = {
        periodType,
        periodKey: period.periodKey,
        periodLabel: period.periodLabel,
        rangeStart: period.rangeStart,
        rangeEnd: period.rangeEnd,
        comparisonKey: period.comparisonKey,
        comparisonLabel: period.comparisonLabel,
        comparisonStart: period.comparisonStart,
        comparisonEnd: period.comparisonEnd,
        dataAsOf: new Date(),
        snapshotVersion: SNAPSHOT_VERSION,
        sourceHash,
        snapshot,
        summary: generated.content.summary,
        highlights: generated.content.highlights,
        risks: generated.content.risks,
        actions: generated.content.actions,
        generationStatus: generated.generationStatus,
        trigger: options.trigger,
        provider: generated.provider,
        model: generated.model,
        latencyMs: generated.latencyMs,
        version: (existing?.version ?? 0) + 1,
        ...(options.generatedBy && mongoose.isValidObjectId(options.generatedBy)
            ? { generatedBy: options.generatedBy }
            : {}),
    };

    const briefing = await ExecutiveBriefing.findOneAndUpdate(
        { periodType, periodKey: period.periodKey },
        { $set: update },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();

    const created = !existing;
    if (briefing && created && options.notify !== false) {
        await notifyDirectorsOnce(String(briefing._id));
    }

    return { briefing, created, changed: true };
};

export const generateExecutiveBriefing = async (
    periodType: BriefingPeriodType,
    options: GenerateOptions
): Promise<BriefingGenerationResult> => {
    const period = getClosedBriefingPeriod(periodType);
    const lockKey = `${periodType}:${period.periodKey}`;
    const running = inFlight.get(lockKey);
    if (running) return running;

    const promise = runGeneration(periodType, options).finally(() => inFlight.delete(lockKey));
    inFlight.set(lockKey, promise);
    return promise;
};

export const ensureLatestExecutiveBriefings = async (
    trigger: BriefingTrigger = 'startup',
    requestedPeriod?: BriefingPeriodType
) => {
    const targets = requestedPeriod ? [requestedPeriod] : periodTypes;
    const results = [];
    for (const periodType of targets) {
        results.push(
            await generateExecutiveBriefing(periodType, {
                trigger,
                notify: true,
            })
        );
    }
    return results.map((result) => ({
        id: String(result.briefing?._id ?? ''),
        periodType: result.briefing?.periodType,
        periodKey: result.briefing?.periodKey,
        created: result.created,
        changed: result.changed,
        generationStatus: result.briefing?.generationStatus,
    }));
};

export const startExecutiveBriefingSchedule = () => {
    if (scheduleStarted) return;
    scheduleStarted = true;

    const runScheduled = (periodType: BriefingPeriodType) => {
        void ensureLatestExecutiveBriefings('cron', periodType).catch((error) =>
            console.error(`[ExecutiveBriefing] Lịch ${periodType} thất bại:`, error)
        );
    };

    CronJob.from({
        cronTime: '0 5 6 * * 1',
        onTick: () => runScheduled('week'),
        start: true,
        timeZone: BRIEFING_TIME_ZONE,
    });
    CronJob.from({
        cronTime: '0 15 6 1 * *',
        onTick: () => runScheduled('month'),
        start: true,
        timeZone: BRIEFING_TIME_ZONE,
    });

    void ensureLatestExecutiveBriefings('startup').catch((error) =>
        console.error('[ExecutiveBriefing] Không thể tạo bù bản tin lúc khởi động:', error)
    );
    console.log('[ExecutiveBriefing] Đã lên lịch bản tin tuần/tháng.');
};

export const getLatestExecutiveBriefing = async (req: Request, res: Response) => {
    const periodType = req.query.period;
    if (!isPeriodType(periodType)) throw new BadRequestError('Kỳ bản tin phải là week hoặc month');

    let briefing = await ExecutiveBriefing.findOne({ periodType }).sort({ rangeEnd: -1 }).lean();
    if (!briefing || Number(briefing.snapshotVersion || 0) < SNAPSHOT_VERSION) {
        const generated = await generateExecutiveBriefing(periodType, { trigger: 'manual', notify: false });
        briefing = generated.briefing;
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: briefing,
            message: 'Lấy bản tin vận hành mới nhất thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const listExecutiveBriefings = async (req: Request, res: Response) => {
    const periodType = req.query.period;
    if (periodType !== undefined && !isPeriodType(periodType)) {
        throw new BadRequestError('Kỳ bản tin phải là week hoặc month');
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 24);
    const rows = await ExecutiveBriefing.find(periodType ? { periodType } : {})
        .select(
            'periodType periodKey periodLabel rangeStart rangeEnd dataAsOf generationStatus trigger provider model version createdAt updatedAt'
        )
        .sort({ rangeEnd: -1 })
        .limit(limit)
        .lean();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: rows,
            message: 'Lấy lịch sử bản tin vận hành thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getExecutiveBriefingById = async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('ID bản tin không hợp lệ');
    const briefing = await ExecutiveBriefing.findById(req.params.id).lean();
    if (!briefing) throw new NotFoundError('Không tìm thấy bản tin vận hành');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: briefing,
            message: 'Lấy chi tiết bản tin vận hành thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const refreshExecutiveBriefing = async (req: Request, res: Response) => {
    const periodType = req.body?.period;
    if (!isPeriodType(periodType)) throw new BadRequestError('Kỳ bản tin phải là week hoặc month');
    const result = await generateExecutiveBriefing(periodType, {
        trigger: 'manual',
        generatedBy: req.userId,
        forceDataRefresh: true,
        forceNarrative: true,
        notify: false,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { ...result.briefing, changed: result.changed },
            message: result.changed ? 'Đã cập nhật bản tin vận hành' : 'Bản tin đang dùng dữ liệu mới nhất',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
