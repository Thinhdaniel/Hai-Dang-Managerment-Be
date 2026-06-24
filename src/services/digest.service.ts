import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CronJob } from 'cron';
import { z } from 'zod';
import {
    endOfMonth,
    endOfWeek,
    format,
    getISOWeek,
    getISOWeekYear,
    startOfMonth,
    startOfWeek,
    subMonths,
    subWeeks,
} from 'date-fns';
import Maintenance from '@/models/Maintenance';
import DistributionRecord from '@/models/DistributionRecord';
import User from '@/models/User';
import AiDigest from '@/models/AiDigest';
import { ROLE_GROUPS } from '@/constant/permissions';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { notifyUser } from '@/services/notification.helper';
import { aiProviderService, extractJsonObject } from '@/services/ai/ai-provider.service';
import { AI_FEATURES } from '@/constant/aiModels';
import customResponse from '@/utils/response';

type PeriodType = 'week' | 'month';

const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0);
const vnd = (v: number) => `${Math.round(v).toLocaleString('vi-VN')}đ`;

const periodRange = (type: PeriodType) => {
    const now = new Date();
    if (type === 'week') {
        const start = startOfWeek(now, { weekStartsOn: 1 });
        const end = endOfWeek(now, { weekStartsOn: 1 });
        return {
            start,
            end,
            prevStart: startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }),
            prevEnd: endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }),
            key: `${getISOWeekYear(now)}-W${String(getISOWeek(now)).padStart(2, '0')}`,
            label: `Tuần ${format(start, 'dd/MM')}–${format(end, 'dd/MM/yyyy')}`,
        };
    }
    const start = startOfMonth(now);
    return {
        start,
        end: endOfMonth(now),
        prevStart: startOfMonth(subMonths(now, 1)),
        prevEnd: endOfMonth(subMonths(now, 1)),
        key: format(now, 'yyyy-MM'),
        label: `Tháng ${format(now, 'MM/yyyy')}`,
    };
};

const countTickets = (start: Date, end: Date) =>
    Maintenance.countDocuments({ isDeleted: { $ne: true }, createdAt: { $gte: start, $lte: end } });

const repairCostInRange = async (start: Date, end: Date) => {
    const [row] = await Maintenance.aggregate<{ total: number }>([
        { $match: { isDeleted: { $ne: true }, repairMode: 'external', status: 'completed', endDate: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$cost', 0] } } } },
    ]);
    return row?.total ?? 0;
};

const distributionCostInRange = async (start: Date, end: Date) => {
    const [row] = await DistributionRecord.aggregate<{ total: number }>([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] }, createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$totalWithVat', { $ifNull: ['$totalAmount', 0] }] } } } },
    ]);
    return row?.total ?? 0;
};

const topBrokenInRange = async (start: Date, end: Date, limit = 5) => {
    const rows = await Maintenance.aggregate([
        { $match: { isDeleted: { $ne: true }, createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$assetId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'asset' } },
        { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'plants', localField: 'asset.plantId', foreignField: '_id', as: 'plant' } },
        { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
    ]);
    return rows.map((r: any) => ({
        machineCode: r.asset?.machineCode,
        name: r.asset?.name,
        plantName: r.plant?.name,
        count: r.count,
    }));
};

// ===== Snapshot số liệu thật của kỳ =====
const buildSnapshot = async (type: PeriodType) => {
    const r = periodRange(type);
    const [summary, overdue, mislocated, resolution, newTickets, newTicketsPrev, repair, repairPrev, dist, distPrev, topBroken] =
        await Promise.all([
            dashboardRepository.getSummaryMetrics(),
            dashboardRepository.getOverdueTickets(7, 5),
            dashboardRepository.getMislocatedAssets(50),
            dashboardRepository.getResolutionStats(),
            countTickets(r.start, r.end),
            countTickets(r.prevStart, r.prevEnd),
            repairCostInRange(r.start, r.end),
            repairCostInRange(r.prevStart, r.prevEnd),
            distributionCostInRange(r.start, r.end),
            distributionCostInRange(r.prevStart, r.prevEnd),
            topBrokenInRange(r.start, r.end, 5),
        ]);

    const totalCost = repair + dist;
    const totalCostPrev = repairPrev + distPrev;

    return {
        periodType: type,
        periodKey: r.key,
        periodLabel: r.label,
        rangeStart: r.start,
        rangeEnd: r.end,
        machines: {
            total: summary.totalMachines,
            active: summary.activeMachines,
            maintenance: summary.maintenanceMachines,
            inactive: summary.inactiveMachines,
        },
        maintenance: {
            newTickets,
            newTicketsPrev,
            newTicketsDeltaPct: pct(newTickets, newTicketsPrev),
            overdueCount: overdue.count,
            avgResolutionDays: resolution.avgDaysThisMonth,
        },
        cost: {
            repair,
            repairPrev,
            distribution: dist,
            distributionPrev: distPrev,
            total: totalCost,
            totalPrev: totalCostPrev,
            totalDeltaPct: pct(totalCost, totalCostPrev),
        },
        gps: { mislocatedCount: mislocated.length },
        topBroken,
    };
};

const digestSchema = z.object({
    narrative: z.string().max(2500),
    highlights: z.array(z.string().max(300)).max(8).default([]),
    alerts: z.array(z.string().max(300)).max(8).default([]),
    recommendations: z.array(z.string().max(300)).max(8).default([]),
});

const DIGEST_SYSTEM = [
    'Ban la tro ly phan tich van hanh, viet ban tin tom tat cho GIAM DOC cong ty may.',
    'Chi dung SO LIEU duoc cung cap, TUYET DOI khong bia them con so.',
    'Viet tieng Viet, ngan gon, chuyen nghiep. Neu bat noi bat, thay doi so voi ky truoc, va canh bao rui ro.',
    'Tra ve DUY NHAT JSON: {"narrative": "doan tom tat 4-8 cau", "highlights": ["diem noi bat"], "alerts": ["canh bao rui ro"], "recommendations": ["khuyen nghi hanh dong"]}',
].join('\n');

const fallbackNarrative = (s: any) =>
    `${s.periodLabel}: ${s.machines.total} máy (${s.machines.active} hoạt động, ${s.machines.maintenance} bảo trì). ` +
    `Phát sinh ${s.maintenance.newTickets} phiếu bảo trì (${s.maintenance.newTicketsDeltaPct >= 0 ? '+' : ''}${s.maintenance.newTicketsDeltaPct}% so kỳ trước), ` +
    `${s.maintenance.overdueCount} phiếu quá hạn. Tổng chi phí ${vnd(s.cost.total)} (${s.cost.totalDeltaPct >= 0 ? '+' : ''}${s.cost.totalDeltaPct}%). ` +
    `${s.gps.mislocatedCount} máy lệch vị trí GPS.`;

export const generateDigest = async (type: PeriodType, generatedBy?: string) => {
    const snapshot = await buildSnapshot(type);

    let narrative = fallbackNarrative(snapshot);
    let highlights: string[] = [];
    let alerts: string[] = [];
    let recommendations: string[] = [];
    let provider = 'fallback';
    let model: string | undefined;

    try {
        const ai = await aiProviderService.generateJson<unknown>({
            feature: AI_FEATURES.DIGEST,
            temperature: 0.3,
            maxTokens: 1000,
            messages: [
                { role: 'system', content: DIGEST_SYSTEM },
                { role: 'user', content: JSON.stringify(snapshot) },
            ],
        });
        const parsed = digestSchema.parse(JSON.parse(extractJsonObject((ai as any).content)));
        narrative = parsed.narrative || narrative;
        highlights = parsed.highlights;
        alerts = parsed.alerts;
        recommendations = parsed.recommendations;
        provider = ai.provider;
        model = ai.model;
    } catch {
        // AI lỗi -> giữ narrative fallback từ số liệu thật.
    }

    const { periodKey, periodLabel, rangeStart, rangeEnd, ...metrics } = snapshot;
    const doc = await AiDigest.findOneAndUpdate(
        { periodType: type, periodKey },
        {
            $set: {
                periodType: type,
                periodKey,
                periodLabel,
                rangeStart,
                rangeEnd,
                snapshot: metrics,
                narrative,
                highlights,
                alerts,
                recommendations,
                provider,
                model,
                generatedBy: generatedBy || undefined,
            },
        },
        { upsert: true, new: true }
    );
    return doc;
};

const notifyDirectors = async (digest: any) => {
    const directors = await User.find({
        role: { $in: [...ROLE_GROUPS.DIRECTOR_UP] },
        isDeleted: { $ne: true },
        isActive: true,
    }).select('_id');
    for (const d of directors) {
        await notifyUser(String(d._id), 'notify:new', {
            title: `Bản tin AI – ${digest.periodLabel}`,
            message: digest.highlights?.[0] || (digest.narrative || '').slice(0, 160),
            type: 'info',
            actionType: 'digest',
            actionId: String(digest._id),
        });
    }
};

// ===== Cron tự động =====
const runScheduled = async (type: PeriodType) => {
    try {
        const doc = await generateDigest(type);
        await notifyDirectors(doc);
        console.log(`[Digest] Đã sinh bản tin ${type}: ${doc.periodKey}`);
    } catch (error) {
        console.error('[Digest] Sinh bản tin tự động thất bại:', error);
    }
};

export const startDigestSchedules = () => {
    const timeZone = 'Asia/Ho_Chi_Minh';
    // Thứ Hai 07:00 hằng tuần (giây phút giờ ngày tháng thứ)
    CronJob.from({ cronTime: '0 0 7 * * 1', onTick: () => void runScheduled('week'), start: true, timeZone });
    // Ngày 1 hằng tháng 07:30
    CronJob.from({ cronTime: '0 30 7 1 * *', onTick: () => void runScheduled('month'), start: true, timeZone });
    console.log('[Digest] Đã lên lịch bản tin AI (tuần: T2 07:00, tháng: ngày 1 07:30).');
};

// ===== HTTP =====
export const getLatestDigest = async (req: Request, res: Response) => {
    const type = (String(req.query.type) === 'month' ? 'month' : 'week') as PeriodType;
    const doc = await AiDigest.findOne({ periodType: type }).sort({ createdAt: -1 }).lean();
    return res.status(StatusCodes.OK).json(
        customResponse({ data: doc, message: 'Ban tin moi nhat', status: StatusCodes.OK, success: true })
    );
};

export const listDigests = async (req: Request, res: Response) => {
    const type = (String(req.query.type) === 'month' ? 'month' : 'week') as PeriodType;
    const docs = await AiDigest.find({ periodType: type }).sort({ createdAt: -1 }).limit(12).lean();
    return res.status(StatusCodes.OK).json(
        customResponse({ data: docs, message: 'Danh sach ban tin', status: StatusCodes.OK, success: true })
    );
};

export const generateDigestNow = async (req: Request, res: Response) => {
    const type = (String(req.body.type) === 'month' ? 'month' : 'week') as PeriodType;
    const doc = await generateDigest(type, req.userId);
    return res.status(StatusCodes.OK).json(
        customResponse({ data: doc, message: 'Da tao ban tin', status: StatusCodes.OK, success: true })
    );
};
