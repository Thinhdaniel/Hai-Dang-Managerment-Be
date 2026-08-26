import { createHash } from 'crypto';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CronJob } from 'cron';
import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import Plant from '@/models/Plant';
import User from '@/models/User';
import StocktakeSession from '@/models/StocktakeSession';
import RealityAlertRule from '@/models/RealityAlertRule';
import RealityHealthSnapshot from '@/models/RealityHealthSnapshot';
import RealityOperationalAlert from '@/models/RealityOperationalAlert';
import { buildFloorMapRealityHealth } from '@/services/floor-map.service';
import { notifyUser } from '@/services/notification.helper';

type Signal = {
    code: 'low_score' | 'zone_drift' | 'stale_evidence' | 'coverage_overdue' | 'proposal_overdue';
    scopeKey: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    message: string;
    zoneId?: string;
    zoneName?: string;
    assetIds?: string[];
    metrics: Record<string, number | string | null>;
};

const DEFAULT_RULE = {
    enabled: true,
    staleDays: 30,
    minScore: 65,
    driftThreshold: 1,
    stalePercentThreshold: 25,
    coverageOverdueDays: 30,
    proposalOverdueDays: 3,
    cooldownHours: 24,
};

const dateKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(date);

const metricHash = (metrics: Record<string, unknown>) =>
    createHash('sha256')
        .update(JSON.stringify(metrics, Object.keys(metrics).sort()))
        .digest('hex')
        .slice(0, 24);

const getRule = async (plantId: string) => {
    try {
        return await RealityAlertRule.findOneAndUpdate(
            { plantId },
            { $setOnInsert: { plantId, ...DEFAULT_RULE } },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
        const existing = await RealityAlertRule.findOne({ plantId });
        if (!existing) throw error;
        return existing;
    }
};

const getPlantManagementIds = async (plantId: string) => {
    const users = await User.find({
        isDeleted: { $ne: true },
        isActive: true,
        $or: [{ role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR] } }, { role: USER_ROLE.MANAGER, plantId }],
    }).select('_id');
    return users.map((user) => String(user._id));
};

const notifyPlantManagement = async (plantId: string, alert: any) => {
    const recipientIds = await getPlantManagementIds(plantId);
    await Promise.all(
        recipientIds.map((userId) =>
            notifyUser(userId, 'notify:new', {
                type: alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info',
                actionType: 'floor_map',
                actionId: plantId,
                title: alert.title,
                message: alert.message,
            })
        )
    );
    return recipientIds.length;
};

const serializeAlert = (input: any) => {
    const alert = typeof input?.toObject === 'function' ? input.toObject() : input;
    const assignee = alert.assignedTo && typeof alert.assignedTo === 'object' ? alert.assignedTo : undefined;
    return {
        id: String(alert._id),
        plantId: String(alert.plantId?._id ?? alert.plantId),
        code: alert.code,
        scopeKey: alert.scopeKey,
        severity: alert.severity,
        status: alert.status,
        title: alert.title,
        message: alert.message,
        zoneId: alert.zoneId ? String(alert.zoneId) : undefined,
        zoneName: alert.zoneName,
        assetIds: (alert.assetIds ?? []).map(String),
        metrics: alert.metrics ?? {},
        assignedTo: assignee?._id ? String(assignee._id) : alert.assignedTo ? String(alert.assignedTo) : undefined,
        assignedToName: assignee?.fullname || assignee?.username || assignee?.email,
        dueAt: alert.dueAt?.toISOString?.() ?? alert.dueAt,
        firstDetectedAt: alert.firstDetectedAt?.toISOString?.() ?? alert.firstDetectedAt,
        lastDetectedAt: alert.lastDetectedAt?.toISOString?.() ?? alert.lastDetectedAt,
        lastNotifiedAt: alert.lastNotifiedAt?.toISOString?.() ?? alert.lastNotifiedAt,
        occurrenceCount: alert.occurrenceCount ?? 1,
        resolvedAt: alert.resolvedAt?.toISOString?.() ?? alert.resolvedAt,
        resolutionNote: alert.resolutionNote,
        createdAt: alert.createdAt?.toISOString?.() ?? alert.createdAt,
        updatedAt: alert.updatedAt?.toISOString?.() ?? alert.updatedAt,
    };
};

const buildSignals = async (plantId: string, health: any, rule: any): Promise<Signal[]> => {
    const signals: Signal[] = [];
    if (health.score < rule.minScore) {
        signals.push({
            code: 'low_score',
            scopeKey: 'plant',
            severity: health.score < Math.max(rule.minScore - 20, 20) ? 'critical' : 'warning',
            title: `Độ tin cậy sơ đồ giảm còn ${health.score}%`,
            message: `${health.counts.drift} máy sai vùng, ${health.counts.unplaced} máy chưa xếp và ${health.counts.unverified} máy chưa xác minh.`,
            assetIds: health.machines
                .filter((item: any) => item.status !== 'verified')
                .map((item: any) => item.assetId),
            metrics: { score: health.score, threshold: rule.minScore, total: health.total },
        });
    }

    health.zones.forEach((zone: any) => {
        if (zone.counts.drift < rule.driftThreshold) return;
        const assetIds = health.machines
            .filter((item: any) => item.status === 'drift' && item.evidence?.zoneId === zone.zoneId)
            .map((item: any) => item.assetId);
        signals.push({
            code: 'zone_drift',
            scopeKey: zone.zoneId,
            severity: zone.counts.drift >= Math.max(rule.driftThreshold * 3, 5) ? 'critical' : 'warning',
            title: `${zone.counts.drift} máy lệch khỏi vùng ${zone.zoneName}`,
            message: `QR kiểm kê phát hiện máy tại ${zone.zoneName} nhưng sơ đồ đang xếp ở vùng khác.`,
            zoneId: zone.zoneId,
            zoneName: zone.zoneName,
            assetIds,
            metrics: { drift: zone.counts.drift, threshold: rule.driftThreshold, zoneScore: zone.score },
        });
    });

    const stalePercent = health.total ? Math.round((health.counts.stale / health.total) * 100) : 0;
    if (stalePercent >= rule.stalePercentThreshold) {
        signals.push({
            code: 'stale_evidence',
            scopeKey: 'plant',
            severity: stalePercent >= 50 ? 'critical' : 'warning',
            title: `${stalePercent}% máy có bằng chứng vị trí đã cũ`,
            message: `${health.counts.stale}/${health.total} máy chưa được xác minh lại trong ${rule.staleDays} ngày.`,
            assetIds: health.machines.filter((item: any) => item.status === 'stale').map((item: any) => item.assetId),
            metrics: { stalePercent, staleCount: health.counts.stale, threshold: rule.stalePercentThreshold },
        });
    }

    const coverageCutoff = new Date(Date.now() - rule.coverageOverdueDays * 86_400_000);
    const latestFullCoverage = await StocktakeSession.findOne({
        plantId,
        coveragePercent: 100,
        createdAt: { $gte: coverageCutoff },
    })
        .select('_id createdAt')
        .sort('-createdAt')
        .lean();
    if (!latestFullCoverage) {
        signals.push({
            code: 'coverage_overdue',
            scopeKey: 'plant',
            severity: 'warning',
            title: `Cơ sở chưa hoàn tất kiểm kê coverage trong ${rule.coverageOverdueDays} ngày`,
            message: 'Danh sách máy thiếu và điểm tin cậy có thể chưa phản ánh đầy đủ thực tế toàn xưởng.',
            metrics: { overdueDays: rule.coverageOverdueDays, lastFullCoverageAt: null },
        });
    }

    const proposalCutoff = new Date(Date.now() - rule.proposalOverdueDays * 86_400_000);
    const overdueProposals = await StocktakeSession.aggregate([
        { $match: { plantId: new mongoose.Types.ObjectId(plantId) } },
        { $unwind: '$positionProposals' },
        {
            $match: {
                'positionProposals.status': 'pending',
                'positionProposals.scannedAt': { $lt: proposalCutoff },
            },
        },
        {
            $group: {
                _id: null,
                count: { $sum: 1 },
                assetIds: { $addToSet: '$positionProposals.assetId' },
            },
        },
    ]);
    if (overdueProposals[0]?.count) {
        signals.push({
            code: 'proposal_overdue',
            scopeKey: 'plant',
            severity: overdueProposals[0].count >= 10 ? 'critical' : 'warning',
            title: `${overdueProposals[0].count} đề xuất vị trí chờ duyệt quá hạn`,
            message: `Các đề xuất đã chờ quá ${rule.proposalOverdueDays} ngày và chưa được xử lý.`,
            assetIds: overdueProposals[0].assetIds.map(String),
            metrics: { count: overdueProposals[0].count, overdueDays: rule.proposalOverdueDays },
        });
    }
    return signals;
};

const runPlantRealityEvaluation = async (plantId: string, options?: { notify?: boolean }) => {
    const rule = await getRule(plantId);
    const health = await buildFloorMapRealityHealth(plantId, rule.staleDays);
    const snapshotUpdate = {
        generatedAt: new Date(),
        score: health.score,
        total: health.total,
        counts: health.counts,
        zones: health.zones.map((zone: any) => ({
            zoneId: zone.zoneId,
            zoneName: zone.zoneName,
            total: zone.total,
            score: zone.score,
            counts: zone.counts,
        })),
        latestSessionId: health.latestSession?.id,
    };
    try {
        await RealityHealthSnapshot.findOneAndUpdate(
            { plantId, snapshotKey: dateKey() },
            { $set: snapshotUpdate },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
        await RealityHealthSnapshot.updateOne({ plantId, snapshotKey: dateKey() }, { $set: snapshotUpdate });
    }
    if (!rule.enabled) {
        return { score: health.score, total: health.total, opened: 0, updated: 0, resolved: 0, notified: 0 };
    }

    const signals = await buildSignals(plantId, health, rule);
    const activeKeys = new Set(signals.map((signal) => `${plantId}:${signal.code}:${signal.scopeKey}`));
    let opened = 0;
    let updated = 0;
    let notified = 0;
    const alertsToNotify: any[] = [];
    const now = new Date();
    for (const signal of signals) {
        const activeKey = `${plantId}:${signal.code}:${signal.scopeKey}`;
        const hash = metricHash(signal.metrics);
        let alert = await RealityOperationalAlert.findOne({ activeKey });
        if (!alert) {
            const recentlyClosed = await RealityOperationalAlert.findOne({
                plantId,
                code: signal.code,
                scopeKey: signal.scopeKey,
                status: { $in: ['resolved', 'dismissed'] },
                resolvedBy: { $exists: true, $ne: null },
            }).sort('-resolvedAt');
            const stillSuppressed =
                recentlyClosed?.metricHash === hash &&
                recentlyClosed.resolvedAt &&
                now.getTime() - recentlyClosed.resolvedAt.getTime() < rule.cooldownHours * 3_600_000;
            if (stillSuppressed) continue;
            const dueDays = signal.severity === 'critical' ? 1 : signal.severity === 'warning' ? 3 : 7;
            try {
                alert = await RealityOperationalAlert.create({
                    plantId,
                    code: signal.code,
                    activeKey,
                    scopeKey: signal.scopeKey,
                    severity: signal.severity,
                    title: signal.title,
                    message: signal.message,
                    zoneId: signal.zoneId,
                    zoneName: signal.zoneName,
                    assetIds: signal.assetIds?.slice(0, 500) ?? [],
                    metrics: signal.metrics,
                    metricHash: hash,
                    assignedTo: rule.defaultAssignee,
                    dueAt: new Date(now.getTime() + dueDays * 86_400_000),
                });
            } catch (error: any) {
                if (error?.code === 11000) continue;
                throw error;
            }
            opened += 1;
        } else {
            const signalChanged = alert.metricHash !== hash;
            alert.severity = signal.severity;
            alert.title = signal.title;
            alert.message = signal.message;
            alert.zoneId = signal.zoneId ? new mongoose.Types.ObjectId(signal.zoneId) : undefined;
            alert.zoneName = signal.zoneName;
            alert.assetIds = (signal.assetIds ?? []).slice(0, 500).map((id) => new mongoose.Types.ObjectId(id));
            alert.metrics = signal.metrics;
            alert.metricHash = hash;
            alert.lastDetectedAt = now;
            if (signalChanged) alert.occurrenceCount += 1;
            await alert.save();
            if (signalChanged) updated += 1;
        }

        if (options?.notify !== false) {
            const notificationCutoff = new Date(now.getTime() - rule.cooldownHours * 3_600_000);
            const claimed = await RealityOperationalAlert.findOneAndUpdate(
                {
                    _id: alert._id,
                    lastNotifiedMetricHash: { $ne: hash },
                    $or: [
                        { lastNotifiedAt: { $exists: false } },
                        { lastNotifiedAt: null },
                        { lastNotifiedAt: { $lte: notificationCutoff } },
                    ],
                },
                { $set: { lastNotifiedAt: now, lastNotifiedMetricHash: hash } },
                { returnDocument: 'after' }
            );
            if (claimed) alertsToNotify.push(claimed);
        }
    }

    if (alertsToNotify.length) {
        const severityRank = { info: 1, warning: 2, critical: 3 } as const;
        const highest = [...alertsToNotify].sort(
            (left, right) =>
                severityRank[right.severity as keyof typeof severityRank] -
                severityRank[left.severity as keyof typeof severityRank]
        )[0];
        const preview = alertsToNotify
            .slice(0, 3)
            .map((alert) => alert.title)
            .join('; ');
        notified = await notifyPlantManagement(plantId, {
            severity: highest.severity,
            title: `Reality Operations có ${alertsToNotify.length} cảnh báo cần chú ý`,
            message: `${preview}${alertsToNotify.length > 3 ? `; và ${alertsToNotify.length - 3} cảnh báo khác` : ''}`,
        });
    }

    const staleAlerts = await RealityOperationalAlert.find({
        plantId,
        status: { $in: ['open', 'in_progress'] },
        activeKey: { $nin: Array.from(activeKeys) },
    });
    for (const alert of staleAlerts) {
        alert.status = 'resolved';
        alert.resolvedAt = now;
        alert.resolutionNote = 'Hệ thống tự đóng vì chỉ số đã trở lại ngưỡng an toàn';
        alert.activeKey = undefined;
        await alert.save();
    }
    return {
        score: health.score,
        total: health.total,
        opened,
        updated,
        resolved: staleAlerts.length,
        notified,
    };
};

const evaluationPromises = new Map<string, Promise<any>>();
export const evaluatePlantRealityOperations = (plantId: string, options?: { notify?: boolean }) => {
    const running = evaluationPromises.get(plantId);
    if (running) return running;
    const evaluation = runPlantRealityEvaluation(plantId, options).finally(() => {
        evaluationPromises.delete(plantId);
    });
    evaluationPromises.set(plantId, evaluation);
    return evaluation;
};

export const evaluateAllRealityOperations = async (options?: { notify?: boolean }) => {
    const plants = await Plant.find({ isDeleted: { $ne: true } })
        .select('_id')
        .lean();
    const results = [];
    for (const plant of plants) {
        try {
            results.push({
                plantId: String(plant._id),
                ...(await evaluatePlantRealityOperations(String(plant._id), options)),
            });
        } catch (error) {
            results.push({
                plantId: String(plant._id),
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }
    return { checked: plants.length, results };
};

let realityScheduleStarted = false;
export const startRealityOperationsSchedule = () => {
    if (realityScheduleStarted) return;
    realityScheduleStarted = true;
    CronJob.from({
        cronTime: '0 0 8 * * *',
        onTick: () => void evaluateAllRealityOperations({ notify: true }),
        start: true,
        timeZone: 'Asia/Ho_Chi_Minh',
    });
};

export const getRealityOperations = async (req: Request, res: Response) => {
    const plantId = String(req.query.plantId ?? '');
    if (!mongoose.isValidObjectId(plantId)) throw new BadRequestError('Sai co so');
    const [rule, alerts, snapshots, managers] = await Promise.all([
        getRule(plantId),
        RealityOperationalAlert.find({ plantId })
            .populate('assignedTo', 'fullname username email')
            .sort({ status: 1, severity: 1, updatedAt: -1 })
            .limit(100),
        RealityHealthSnapshot.find({ plantId }).sort('-generatedAt').limit(90).lean(),
        User.find({
            isDeleted: { $ne: true },
            isActive: true,
            $or: [{ role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR] } }, { role: USER_ROLE.MANAGER, plantId }],
        })
            .select('fullname username email role plantId')
            .sort('fullname')
            .lean(),
    ]);
    const serializedAlerts = alerts.map(serializeAlert);
    return res.status(StatusCodes.OK).json({
        rule: rule.toObject(),
        alerts: serializedAlerts,
        summary: {
            open: serializedAlerts.filter((item) => item.status === 'open').length,
            inProgress: serializedAlerts.filter((item) => item.status === 'in_progress').length,
            overdue: serializedAlerts.filter(
                (item) =>
                    ['open', 'in_progress'].includes(item.status) && item.dueAt && new Date(item.dueAt) < new Date()
            ).length,
            resolved: serializedAlerts.filter((item) => item.status === 'resolved').length,
        },
        snapshots: snapshots.map((item: any) => ({
            id: String(item._id),
            snapshotKey: item.snapshotKey,
            generatedAt: item.generatedAt?.toISOString?.() ?? item.generatedAt,
            score: item.score,
            total: item.total,
            counts: item.counts,
        })),
        managers: managers.map((user: any) => ({
            id: String(user._id),
            name: user.fullname || user.username || user.email,
            role: user.role,
        })),
    });
};

export const updateRealityAlertRule = async (req: Request, res: Response) => {
    const plantId = String(req.body.plantId ?? '');
    if (!mongoose.isValidObjectId(plantId)) throw new BadRequestError('Sai co so');
    if (req.body.defaultAssignee) {
        const assignee = await User.findOne({
            _id: req.body.defaultAssignee,
            isDeleted: { $ne: true },
            isActive: true,
            $or: [{ role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR] } }, { role: USER_ROLE.MANAGER, plantId }],
        });
        if (!assignee) throw new BadRequestError('Nguoi phu trach khong hop le');
    }
    const rule = await RealityAlertRule.findOneAndUpdate(
        { plantId },
        { $set: { ...req.body, updatedBy: req.userId } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    void evaluatePlantRealityOperations(plantId, { notify: true }).catch((error) =>
        console.error('[RealityOperations] Rule evaluation failed:', error)
    );
    return res.status(StatusCodes.OK).json(rule);
};

export const updateRealityOperationalAlert = async (req: Request, res: Response) => {
    const alert = await RealityOperationalAlert.findById(req.params.id);
    if (!alert) throw new NotFoundError('Khong tim thay canh bao');
    let assignedChanged = false;
    if (req.body.assignedTo) {
        const assignee = await User.findOne({
            _id: req.body.assignedTo,
            isDeleted: { $ne: true },
            isActive: true,
            $or: [
                { role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR] } },
                { role: USER_ROLE.MANAGER, plantId: alert.plantId },
            ],
        });
        if (!assignee) throw new BadRequestError('Nguoi phu trach khong hop le');
        assignedChanged = String(alert.assignedTo ?? '') !== String(assignee._id);
        alert.assignedTo = assignee._id;
    } else if (req.body.assignedTo === null) {
        alert.assignedTo = undefined;
    }
    if (req.body.dueAt !== undefined) alert.dueAt = req.body.dueAt ? new Date(req.body.dueAt) : undefined;
    if (req.body.status) {
        alert.status = req.body.status;
        if (req.body.status === 'in_progress' && !alert.assignedTo) {
            alert.assignedTo = new mongoose.Types.ObjectId(String(req.userId));
            assignedChanged = true;
        }
        if (['resolved', 'dismissed'].includes(req.body.status)) {
            alert.resolvedAt = new Date();
            alert.resolvedBy = new mongoose.Types.ObjectId(String(req.userId));
            alert.resolutionNote = req.body.resolutionNote;
            alert.activeKey = undefined;
        } else {
            alert.resolvedAt = undefined;
            alert.resolvedBy = undefined;
        }
    }
    await alert.save();
    if (assignedChanged && alert.assignedTo) {
        await notifyUser(String(alert.assignedTo), 'notify:new', {
            type: alert.severity === 'critical' ? 'error' : 'warning',
            actionType: 'floor_map',
            actionId: String(alert.plantId),
            title: 'Bạn được giao xử lý cảnh báo sơ đồ',
            message: alert.title,
        });
    }
    await alert.populate('assignedTo', 'fullname username email');
    return res.status(StatusCodes.OK).json(serializeAlert(alert));
};

export const evaluateRealityOperationsNow = async (req: Request, res: Response) => {
    const plantId = String(req.body.plantId ?? '');
    if (!mongoose.isValidObjectId(plantId)) throw new BadRequestError('Sai co so');
    const result = await evaluatePlantRealityOperations(plantId, { notify: true });
    return res.status(StatusCodes.OK).json(result);
};
