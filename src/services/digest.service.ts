import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CronJob } from 'cron';
import mongoose from 'mongoose';
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
import InventoryStock from '@/models/InventoryStock';
import Asset from '@/models/Asset';
import Plant from '@/models/Plant';
import User from '@/models/User';
import AiDigest from '@/models/AiDigest';
import { ROLE_GROUPS } from '@/constant/permissions';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { notifyUser, notifyUserTracked } from '@/services/notification.helper';
import { aiProviderService, extractJsonObject } from '@/services/ai/ai-provider.service';
import { AI_FEATURES } from '@/constant/aiModels';
import { ASSET_OWNERSHIP_TYPE } from '@/constant/assetStatus';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { generateDigestVisual } from '@/services/digest-visual.service';
import { createDigestPdfArtifact, downloadDigestPdf } from '@/services/digest-pdf.service';
import {
    getDigestChecksum,
    normalizeDigestEditorial,
    validateDigestDocument,
} from '@/services/digest-validation.service';
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
        {
            $match: {
                isDeleted: { $ne: true },
                repairMode: 'external',
                status: 'completed',
                endDate: { $gte: start, $lte: end },
            },
        },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$cost', 0] } } } },
    ]);
    return row?.total ?? 0;
};

const distributionCostInRange = async (start: Date, end: Date) => {
    const [row] = await DistributionRecord.aggregate<{ total: number }>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: { $in: ['distributed', 'confirmed'] },
                createdAt: { $gte: start, $lte: end },
            },
        },
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

const lowStockSnapshot = async (limit = 12) => {
    const rows = await InventoryStock.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $lookup: { from: 'materials', localField: 'materialId', foreignField: '_id', as: 'material' } },
        { $unwind: '$material' },
        { $lookup: { from: 'plants', localField: 'plantId', foreignField: '_id', as: 'plant' } },
        { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
        {
            $match: {
                'material.isDeleted': { $ne: true },
                'material.isActive': { $ne: false },
                'material.trackInventory': { $ne: false },
                $expr: { $lte: ['$currentStock', { $ifNull: ['$material.minStockLevel', 0] }] },
            },
        },
        {
            $project: {
                _id: 0,
                materialId: { $toString: '$material._id' },
                materialCode: '$material.code',
                materialName: '$material.name',
                unit: '$material.unit',
                plantId: { $toString: '$plantId' },
                plantName: { $ifNull: ['$plant.name', 'Chưa gán cơ sở'] },
                currentStock: { $ifNull: ['$currentStock', 0] },
                minStockLevel: { $ifNull: ['$material.minStockLevel', 0] },
                shortage: {
                    $max: [{ $subtract: [{ $ifNull: ['$material.minStockLevel', 0] }, '$currentStock'] }, 0],
                },
            },
        },
        { $sort: { shortage: -1, currentStock: 1, materialName: 1 } },
        { $limit: limit },
    ]);
    return rows;
};

const successfulRepairsInRange = async (start: Date, end: Date, limit = 8) => {
    const docs = await Maintenance.find({
        isDeleted: { $ne: true },
        status: 'completed',
        endDate: { $gte: start, $lte: end },
    })
        .sort({ endDate: -1 })
        .limit(30)
        .populate('assetId', 'machineCode name')
        .populate('assetIds', 'machineCode name')
        .populate('plantId', 'name')
        .lean();

    return docs
        .map((doc: any) => {
            const assets = doc.assetIds?.length ? doc.assetIds : doc.assetId ? [doc.assetId] : [];
            const codes = assets.map((asset: any) => asset.machineCode).filter(Boolean);
            return {
                id: String(doc._id),
                machineCode:
                    codes.length > 2 ? `${codes.slice(0, 2).join(', ')} +${codes.length - 2}` : codes.join(', '),
                machineName: assets[0]?.name,
                machineCount: assets.length,
                plantName: doc.plantName || doc.plantId?.name || 'Chưa rõ cơ sở',
                description: doc.description,
                repairMode: doc.repairMode || 'internal',
                technician: doc.technician,
                completedAt: doc.endDate,
                resolutionDays:
                    doc.startDate && doc.endDate
                        ? Math.max(
                              0,
                              Math.round(
                                  (new Date(doc.endDate).getTime() - new Date(doc.startDate).getTime()) / 86400000
                              )
                          )
                        : undefined,
                cost: Number(doc.cost || 0),
                beforeImages: doc.beforeImages || [],
                afterImages: doc.afterImages || [],
                hasBeforeAfter: Boolean(doc.beforeImages?.length && doc.afterImages?.length),
            };
        })
        .sort((a, b) => Number(b.hasBeforeAfter) - Number(a.hasBeforeAfter))
        .slice(0, limit);
};

const notableIncidentsInRange = async (start: Date, end: Date, limit = 6) => {
    const docs = await Maintenance.find({
        isDeleted: { $ne: true },
        type: 'emergency',
        status: { $ne: 'cancelled' },
        createdAt: { $gte: start, $lte: end },
    })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('assetId', 'machineCode name')
        .populate('assetIds', 'machineCode name')
        .populate('plantId', 'name')
        .lean();
    const priority: Record<string, number> = { overdue: 0, in_progress: 1, pending: 2, completed: 3 };

    return docs
        .map((doc: any) => {
            const assets = doc.assetIds?.length ? doc.assetIds : doc.assetId ? [doc.assetId] : [];
            const codes = assets.map((asset: any) => asset.machineCode).filter(Boolean);
            return {
                id: String(doc._id),
                machineCode:
                    codes.length > 2 ? `${codes.slice(0, 2).join(', ')} +${codes.length - 2}` : codes.join(', '),
                machineName: assets[0]?.name,
                machineCount: assets.length,
                plantName: doc.plantName || doc.plantId?.name || 'Chưa rõ cơ sở',
                description: doc.description,
                status: doc.status,
                occurredAt: doc.createdAt,
                beforeImages: doc.beforeImages || [],
                afterImages: doc.afterImages || [],
            };
        })
        .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9))
        .slice(0, limit);
};

const plantPerformanceInRange = async (start: Date, end: Date, lowStock: any[]) => {
    const [plants, assetRows, tickets] = await Promise.all([
        Plant.find({ isDeleted: { $ne: true } })
            .select('_id name')
            .lean(),
        Asset.aggregate([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                },
            },
            {
                $group: {
                    _id: '$plantId',
                    total: { $sum: 1 },
                    active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                    maintenance: { $sum: { $cond: [{ $eq: ['$status', 'maintenance'] }, 1, 0] } },
                    inactive: { $sum: { $cond: [{ $in: ['$status', ['broken', 'storage']] }, 1, 0] } },
                },
            },
        ]),
        Maintenance.find({
            isDeleted: { $ne: true },
            $or: [
                { createdAt: { $gte: start, $lte: end } },
                { status: 'completed', endDate: { $gte: start, $lte: end } },
                { status: { $in: ['pending', 'in_progress', 'overdue'] } },
            ],
        })
            .select('plantId status startDate endDate createdAt')
            .lean(),
    ]);

    const byPlant = new Map<string, any>();
    plants.forEach((plant: any) =>
        byPlant.set(String(plant._id), {
            plantId: String(plant._id),
            plantName: plant.name,
            totalMachines: 0,
            activeMachines: 0,
            maintenanceMachines: 0,
            inactiveMachines: 0,
            newTickets: 0,
            completedRepairs: 0,
            openTickets: 0,
            avgResolutionDays: 0,
            lowStockCount: 0,
            achievements: [] as string[],
        })
    );
    assetRows.forEach((row: any) => {
        const item = byPlant.get(String(row._id));
        if (!item) return;
        item.totalMachines = Number(row.total || 0);
        item.activeMachines = Number(row.active || 0);
        item.maintenanceMachines = Number(row.maintenance || 0);
        item.inactiveMachines = Number(row.inactive || 0);
    });

    const resolutionDays = new Map<string, number[]>();
    tickets.forEach((ticket: any) => {
        const key = String(ticket.plantId || '');
        const item = byPlant.get(key);
        if (!item) return;
        const createdAt = ticket.createdAt ? new Date(ticket.createdAt).getTime() : 0;
        const endAt = ticket.endDate ? new Date(ticket.endDate).getTime() : 0;
        if (createdAt >= start.getTime() && createdAt <= end.getTime()) item.newTickets += 1;
        if (ticket.status === 'completed' && endAt >= start.getTime() && endAt <= end.getTime()) {
            item.completedRepairs += 1;
            if (ticket.startDate && ticket.endDate) {
                const days = Math.max(
                    0,
                    (new Date(ticket.endDate).getTime() - new Date(ticket.startDate).getTime()) / 86400000
                );
                resolutionDays.set(key, [...(resolutionDays.get(key) || []), days]);
            }
        } else if (['pending', 'in_progress', 'overdue'].includes(ticket.status)) item.openTickets += 1;
    });
    lowStock.forEach((row: any) => {
        const item = byPlant.get(String(row.plantId || ''));
        if (item) item.lowStockCount += 1;
    });

    const rows = [...byPlant.values()]
        .filter((item) => item.totalMachines || item.newTickets || item.lowStockCount)
        .map((item) => {
            const durations = resolutionDays.get(item.plantId) || [];
            item.avgResolutionDays = durations.length
                ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1))
                : 0;
            item.activeRate = item.totalMachines ? Math.round((item.activeMachines / item.totalMachines) * 100) : 0;
            if (item.activeRate >= 95) item.achievements.push(`Tỷ lệ máy hoạt động ${item.activeRate}%`);
            if (item.completedRepairs > 0) item.achievements.push(`Hoàn tất ${item.completedRepairs} ca sửa`);
            if (item.openTickets === 0 && item.newTickets > 0) item.achievements.push('Không còn phiếu mở trong kỳ');
            return item;
        });

    const maxCompleted = Math.max(0, ...rows.map((item) => item.completedRepairs));
    rows.forEach((item) => {
        if (maxCompleted > 0 && item.completedRepairs === maxCompleted)
            item.achievements.unshift('Dẫn đầu số ca hoàn tất');
    });
    return rows.sort((a, b) => b.activeRate - a.activeRate || b.completedRepairs - a.completedRepairs);
};

// ===== Snapshot số liệu thật của kỳ =====
const buildSnapshot = async (type: PeriodType) => {
    const r = periodRange(type);
    const [
        summary,
        overdue,
        mislocated,
        resolution,
        newTickets,
        newTicketsPrev,
        repair,
        repairPrev,
        dist,
        distPrev,
        topBroken,
        allLowStock,
        successfulRepairs,
        notableIncidents,
        completedRepairsCount,
        completedWithBeforeAfter,
    ] = await Promise.all([
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
        lowStockSnapshot(500),
        successfulRepairsInRange(r.start, r.end, 8),
        notableIncidentsInRange(r.start, r.end, 6),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            status: 'completed',
            endDate: { $gte: r.start, $lte: r.end },
        }),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            status: 'completed',
            endDate: { $gte: r.start, $lte: r.end },
            'beforeImages.0': { $exists: true },
            'afterImages.0': { $exists: true },
        }),
    ]);

    const plantPerformance = await plantPerformanceInRange(r.start, r.end, allLowStock);

    const totalCost = repair + dist;
    const totalCostPrev = repairPrev + distPrev;
    const evidenceCoveragePct = completedRepairsCount
        ? Math.round((completedWithBeforeAfter / completedRepairsCount) * 100)
        : 0;
    const dataWarnings: string[] = [];
    if (completedRepairsCount > 0 && evidenceCoveragePct < 50)
        dataWarnings.push(
            `Chỉ ${evidenceCoveragePct}% ca sửa hoàn tất có đủ ảnh trước/sau; phần hình ảnh chưa đại diện cho toàn bộ hoạt động.`
        );
    if (!allLowStock.length)
        dataWarnings.push('Không có vật tư dưới định mức hoặc dữ liệu định mức chưa được khai báo.');

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
        notableIncidents,
        successfulRepairs,
        inventory: {
            lowStockCount: allLowStock.length,
            lowStock: allLowStock.slice(0, 12),
        },
        plantPerformance,
        evidence: {
            completedRepairsCount,
            completedWithBeforeAfter,
            coveragePct: evidenceCoveragePct,
        },
        dataWarnings,
    };
};

const digestSchema = z.object({
    narrative: z.string().max(2500),
    highlights: z.array(z.string().max(300)).max(8).default([]),
    alerts: z.array(z.string().max(300)).max(8).default([]),
    recommendations: z.array(z.string().max(300)).max(8).default([]),
});

const digestEditorialSchema = z.object({
    hiddenIncidentIds: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    hiddenRepairIds: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    hiddenMaterialKeys: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
    hiddenPlantIds: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

const isTrustedDigestImageUrl = (value: string) => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com';
    } catch {
        return false;
    }
};

const updateDigestSchema = z
    .object({
        narrative: z.string().trim().max(4000).optional(),
        highlights: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
        alerts: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
        recommendations: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
        editorial: digestEditorialSchema.optional(),
        note: z.string().trim().max(500).optional(),
    })
    .strict();

const coverSchema = z
    .object({
        coverImageUrl: z
            .string()
            .trim()
            .url()
            .max(2000)
            .refine(isTrustedDigestImageUrl, 'Ảnh bìa phải được tải lên Cloudinary của hệ thống')
            .nullable(),
        note: z.string().trim().max(500).optional(),
    })
    .strict();

const DIGEST_SYSTEM = [
    'Ban la tro ly phan tich van hanh, viet ban tin tom tat cho GIAM DOC cong ty may.',
    'Chi dung SO LIEU duoc cung cap, TUYET DOI khong bia them con so.',
    'Du lieu plantPerformance la chi so van hanh xac dinh, khong tu tao diem hay xep hang ngoai cac achievement da co.',
    'Neu dataWarnings co noi dung, phai phan anh gioi han du lieu mot cach ro rang va khong suy dien.',
    'Viet tieng Viet, ngan gon, chuyen nghiep. Neu bat noi bat, thay doi so voi ky truoc, vat tu duoi dinh muc, ca sua thanh cong va canh bao rui ro.',
    'Tra ve DUY NHAT JSON: {"narrative": "doan tom tat 4-8 cau", "highlights": ["diem noi bat"], "alerts": ["canh bao rui ro"], "recommendations": ["khuyen nghi hanh dong"]}',
].join('\n');

const fallbackNarrative = (s: any) =>
    `${s.periodLabel}: ${s.machines.total} máy (${s.machines.active} hoạt động, ${s.machines.maintenance} bảo trì). ` +
    `Phát sinh ${s.maintenance.newTickets} phiếu bảo trì (${s.maintenance.newTicketsDeltaPct >= 0 ? '+' : ''}${s.maintenance.newTicketsDeltaPct}% so kỳ trước), ` +
    `${s.evidence.completedRepairsCount} ca đã hoàn tất và ${s.maintenance.overdueCount} phiếu quá hạn. ` +
    `Có ${s.inventory.lowStockCount} dòng tồn kho dưới định mức. Tổng chi phí ${vnd(s.cost.total)} (${s.cost.totalDeltaPct >= 0 ? '+' : ''}${s.cost.totalDeltaPct}%). ` +
    `${s.gps.mislocatedCount} máy lệch vị trí GPS.`;

const fallbackSections = (s: any) => {
    const highlights = [
        `${s.machines.active}/${s.machines.total} máy đang hoạt động.`,
        `${s.evidence.completedRepairsCount} ca sửa hoàn tất trong kỳ.`,
    ];
    const alerts: string[] = [];
    const recommendations: string[] = [];

    if (s.maintenance.overdueCount > 0) {
        alerts.push(`${s.maintenance.overdueCount} phiếu bảo trì đang quá hạn.`);
        recommendations.push('Phân công người phụ trách và chốt thời hạn xử lý các phiếu bảo trì quá hạn.');
    }
    if (s.inventory.lowStockCount > 0) {
        alerts.push(`${s.inventory.lowStockCount} dòng tồn kho đang bằng hoặc dưới định mức.`);
        recommendations.push('Rà soát tồn thực tế và kế hoạch bổ sung các vật tư dưới định mức.');
    }
    if (s.gps.mislocatedCount > 0) {
        alerts.push(`${s.gps.mislocatedCount} máy có dấu hiệu lệch vị trí GPS.`);
        recommendations.push('Đối chiếu QR và lịch sử điều chuyển của các máy lệch vị trí.');
    }
    for (const warning of s.dataWarnings || []) alerts.push(warning);

    return {
        highlights: highlights.slice(0, 8),
        alerts: alerts.slice(0, 8),
        recommendations: recommendations.slice(0, 8),
    };
};

const toRevision = (doc: any) => ({
    version: Number(doc.version || 1),
    status: doc.status || 'draft',
    snapshot: doc.snapshot || {},
    narrative: doc.narrative,
    highlights: doc.highlights || [],
    alerts: doc.alerts || [],
    recommendations: doc.recommendations || [],
    provider: doc.provider,
    model: doc.model,
    visual: doc.visual,
    editorial: doc.editorial,
    validation: doc.validation,
    artifact: doc.artifact,
    delivery: doc.delivery,
    contentRevision: Number(doc.contentRevision || 0),
    editHistory: doc.editHistory || [],
    generatedBy: doc.generatedBy,
    generatedAt: doc.updatedAt || doc.createdAt || new Date(),
    approvedBy: doc.approvedBy,
    approvedAt: doc.approvedAt,
    approvalNote: doc.approvalNote,
    publishedBy: doc.publishedBy,
    publishedAt: doc.publishedAt,
});

const toPlainDigest = (doc: any) => (typeof doc?.toObject === 'function' ? doc.toObject({ depopulate: true }) : doc);

const addDigestEditHistory = (
    doc: any,
    editedBy: string | undefined,
    changedFields: string[],
    previous: Record<string, any>,
    note?: string
) => {
    const current = Array.isArray(doc.editHistory)
        ? doc.editHistory.map((entry: any) => (typeof entry?.toObject === 'function' ? entry.toObject() : entry))
        : [];
    doc.set(
        'editHistory',
        [
            ...current,
            {
                editedBy: editedBy || null,
                editedAt: new Date(),
                changedFields,
                previous,
                note: note || undefined,
            },
        ].slice(-40)
    );
};

const refreshDigestValidation = (doc: any) => {
    const validation = validateDigestDocument(toPlainDigest(doc));
    doc.set('validation', validation);
    return validation;
};

const markDigestContentChanged = (doc: any) => {
    doc.set('contentRevision', Number(doc.contentRevision || 0) + 1);
    doc.set('artifact', { status: 'none' });
    doc.set('delivery', undefined);
};

export const generateDigest = async (type: PeriodType, generatedBy?: string) => {
    const snapshot = await buildSnapshot(type);
    const existing = await AiDigest.findOne({ periodType: type, periodKey: snapshot.periodKey }).lean();
    const nextVersion = existing ? Number(existing.version || 1) + 1 : 1;

    let narrative = fallbackNarrative(snapshot);
    const fallback = fallbackSections(snapshot);
    let highlights: string[] = fallback.highlights;
    let alerts: string[] = fallback.alerts;
    let recommendations: string[] = fallback.recommendations;
    let provider = 'fallback';
    let model: string | undefined;

    try {
        const ai = await aiProviderService.generateJson<unknown>({
            feature: AI_FEATURES.DIGEST,
            temperature: 0.3,
            // gemini-2.5-pro là model thinking: reasoning trừ vào max_tokens (effort low vẫn ~600-900
            // token) — budget nhỏ sẽ cắt cụt JSON và rơi về fallback (xem ai-ocr.service).
            reasoningEffort: 'low',
            maxTokens: 4000,
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
    } catch (error) {
        // AI lỗi -> giữ narrative fallback từ số liệu thật.
        console.warn('[Digest] AI lỗi, dùng fallback số liệu:', error instanceof Error ? error.message : error);
    }

    const { periodKey, periodLabel, rangeStart, rangeEnd, ...metrics } = snapshot;
    const visual = await generateDigestVisual(snapshot, { periodKey, periodLabel, version: nextVersion });
    const editorial = normalizeDigestEditorial();
    const validation = validateDigestDocument({
        periodType: type,
        periodKey,
        periodLabel,
        rangeStart,
        rangeEnd,
        version: nextVersion,
        contentRevision: 0,
        snapshot: metrics,
        narrative,
        highlights,
        alerts,
        recommendations,
        dataWarnings: snapshot.dataWarnings || [],
        visual,
        editorial,
    });
    const update: Record<string, any> = {
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
            dataWarnings: snapshot.dataWarnings || [],
            provider,
            model,
            visual,
            editorial,
            validation,
            artifact: { status: 'none' },
            contentRevision: 0,
            editHistory: [],
            viewReceipts: [],
            status: 'draft',
            version: nextVersion,
            generatedBy: generatedBy || null,
        },
        $unset: {
            approvedBy: 1,
            approvedAt: 1,
            approvalNote: 1,
            publishedBy: 1,
            publishedAt: 1,
            delivery: 1,
        },
    };
    if (existing) {
        update.$push = {
            revisionHistory: {
                $each: [toRevision(existing)],
                $slice: -12,
            },
        };
    }

    const doc = await AiDigest.findOneAndUpdate({ periodType: type, periodKey }, update, {
        upsert: true,
        new: true,
    });
    return doc;
};

const notifyDirectors = async (digest: any, event: 'draft' | 'published') => {
    const directors = await User.find({
        role: { $in: [...ROLE_GROUPS.DIRECTOR_UP] },
        isDeleted: { $ne: true },
        isActive: true,
    }).select('_id');
    const delivery = {
        expectedRecipients: directors.length,
        inAppCreated: 0,
        webPushSent: 0,
        telegramSent: 0,
        failedChannels: 0,
        deliveredAt: new Date(),
    };

    const results = await Promise.all(
        directors.map(async (d) => {
            const payload = {
                title:
                    event === 'published'
                        ? `Bản tin điều hành đã xuất bản – ${digest.periodLabel}`
                        : `Bản tin điều hành chờ duyệt – ${digest.periodLabel}`,
                message:
                    event === 'published'
                        ? digest.highlights?.[0] || (digest.narrative || '').slice(0, 160)
                        : `Bản nháp v${digest.version} đã sẵn sàng để kiểm tra và phê duyệt.`,
                type: event === 'published' ? 'success' : 'info',
                actionType: 'digest',
                actionId: String(digest._id),
            };
            if (event === 'draft') {
                await notifyUser(String(d._id), 'notify:new', payload);
                return null;
            }

            return notifyUserTracked(String(d._id), 'notify:new', payload);
        })
    );

    for (const result of results) {
        if (!result) continue;
        delivery.inAppCreated += result.inAppCreated;
        delivery.webPushSent += result.webPushSent;
        delivery.telegramSent += result.telegramSent;
        delivery.failedChannels += result.failedChannels;
    }

    return delivery;
};

// ===== Cron tự động =====
const scheduledDigestRuns = new Map<string, Promise<any>>();

export const runScheduledDigest = async (type: PeriodType) => {
    const periodKey = periodRange(type).key;
    const lockKey = `${type}:${periodKey}`;
    const running = scheduledDigestRuns.get(lockKey);
    if (running) return running;

    const task = (async () => {
        const existing = await AiDigest.findOne({ periodType: type, periodKey });
        if (existing) return existing;
        const doc = await generateDigest(type);
        await notifyDirectors(doc, 'draft');
        return doc;
    })();
    scheduledDigestRuns.set(lockKey, task);
    try {
        return await task;
    } finally {
        scheduledDigestRuns.delete(lockKey);
    }
};

const runScheduled = async (type: PeriodType) => {
    try {
        const doc = await runScheduledDigest(type);
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
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Ban tin moi nhat', status: StatusCodes.OK, success: true }));
};

export const listDigests = async (req: Request, res: Response) => {
    const type = (String(req.query.type) === 'month' ? 'month' : 'week') as PeriodType;
    const docs = await AiDigest.find({ periodType: type })
        .select(
            'periodType periodKey periodLabel rangeStart rangeEnd status version contentRevision visual validation artifact createdAt updatedAt'
        )
        .sort({ rangeStart: -1, createdAt: -1 })
        .limit(12)
        .lean();
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: docs, message: 'Danh sach ban tin', status: StatusCodes.OK, success: true }));
};

export const generateDigestNow = async (req: Request, res: Response) => {
    const type = (String(req.body.type) === 'month' ? 'month' : 'week') as PeriodType;
    const doc = await generateDigest(type, req.userId);
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Da tao ban tin', status: StatusCodes.OK, success: true }));
};

const getDigestOrThrow = async (id: string) => {
    if (!mongoose.isValidObjectId(id)) throw new BadRequestError('ID bản tin không hợp lệ');
    const doc = await AiDigest.findById(id);
    if (!doc) throw new NotFoundError('Không tìm thấy bản tin điều hành');
    return doc;
};

export const getDigestById = async (req: Request, res: Response) => {
    const doc = await getDigestOrThrow(String(req.params.id));
    await doc.populate([
        { path: 'generatedBy', select: 'fullname username' },
        { path: 'approvedBy', select: 'fullname username' },
        { path: 'publishedBy', select: 'fullname username' },
        { path: 'editorial.lastEditedBy', select: 'fullname username' },
        { path: 'editHistory.editedBy', select: 'fullname username' },
        { path: 'viewReceipts.userId', select: 'fullname username' },
    ]);
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Chi tiết bản tin', status: StatusCodes.OK, success: true }));
};

export const updateDigestEditorial = async (req: Request, res: Response) => {
    const payload = updateDigestSchema.parse(req.body || {});
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status !== 'draft') throw new BadRequestError('Chỉ được biên tập khi bản tin đang ở trạng thái nháp');

    const previous: Record<string, any> = {};
    const changedFields: string[] = [];
    for (const field of ['narrative', 'highlights', 'alerts', 'recommendations'] as const) {
        if (payload[field] === undefined) continue;
        const current = doc.get(field);
        if (JSON.stringify(current ?? null) === JSON.stringify(payload[field] ?? null)) continue;
        previous[field] = current;
        doc.set(field, payload[field]);
        changedFields.push(field);
    }

    if (payload.editorial) {
        const current = normalizeDigestEditorial(doc.editorial as any);
        const next = normalizeDigestEditorial({ ...current, ...payload.editorial });
        if (JSON.stringify(current) !== JSON.stringify(next)) {
            previous.editorial = current;
            doc.set('editorial', {
                ...next,
                lastEditedBy: req.userId || null,
                lastEditedAt: new Date(),
            });
            changedFields.push('editorial');
        }
    }

    if (changedFields.length === 0) {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: doc,
                message: 'Nội dung không có thay đổi',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    markDigestContentChanged(doc);
    addDigestEditHistory(doc, req.userId, changedFields, previous, payload.note);
    refreshDigestValidation(doc);
    await doc.save();

    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Đã lưu bản biên tập', status: StatusCodes.OK, success: true }));
};

export const updateDigestCover = async (req: Request, res: Response) => {
    const payload = coverSchema.parse(req.body || {});
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status !== 'draft') throw new BadRequestError('Chỉ được thay bìa khi bản tin đang ở trạng thái nháp');

    const previous = { visual: toPlainDigest(doc.visual) };
    doc.set(
        'visual',
        payload.coverImageUrl
            ? {
                  status: 'custom',
                  coverImageUrl: payload.coverImageUrl,
                  provider: 'manual',
                  generatedAt: new Date(),
                  promptVersion: 'manual-cover-v1',
                  aiGenerated: false,
              }
            : {
                  status: 'disabled',
                  promptVersion: 'system-cover-v1',
                  aiGenerated: false,
              }
    );
    markDigestContentChanged(doc);
    addDigestEditHistory(doc, req.userId, ['visual'], previous, payload.note);
    refreshDigestValidation(doc);
    await doc.save();

    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Đã cập nhật ảnh bìa', status: StatusCodes.OK, success: true }));
};

export const regenerateDigestCover = async (req: Request, res: Response) => {
    const note = z.string().trim().max(500).optional().parse(req.body?.note);
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status !== 'draft') throw new BadRequestError('Chỉ được tạo lại bìa khi bản tin đang ở trạng thái nháp');

    const visual = await generateDigestVisual(doc.snapshot, {
        periodKey: doc.periodKey,
        periodLabel: doc.periodLabel || doc.periodKey,
        version: Number(doc.version || 1),
    });
    if (visual.status === 'disabled') {
        throw new BadRequestError('Tính năng tạo ảnh bìa AI chưa được bật trên máy chủ');
    }

    const previous = { visual: toPlainDigest(doc.visual) };
    doc.set('visual', visual);
    markDigestContentChanged(doc);
    addDigestEditHistory(doc, req.userId, ['visual'], previous, note);
    refreshDigestValidation(doc);
    await doc.save();

    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Đã tạo lại ảnh bìa', status: StatusCodes.OK, success: true }));
};

export const validateDigestNow = async (req: Request, res: Response) => {
    const doc = await getDigestOrThrow(String(req.params.id));
    const validation = refreshDigestValidation(doc);
    await doc.save();
    return res
        .status(StatusCodes.OK)
        .json(
            customResponse({ data: validation, message: 'Đã kiểm tra bản tin', status: StatusCodes.OK, success: true })
        );
};

export const approveDigest = async (req: Request, res: Response) => {
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status !== 'draft') throw new BadRequestError('Chỉ bản nháp mới được phê duyệt');

    const validation = refreshDigestValidation(doc);
    if (validation.status === 'blocked') {
        await doc.save();
        const critical = validation.issues
            .filter((issue) => issue.severity === 'critical')
            .map((issue) => issue.title)
            .slice(0, 3)
            .join('; ');
        throw new BadRequestError(`Bản tin chưa đủ điều kiện phê duyệt: ${critical}`);
    }

    doc.status = 'approved';
    doc.approvedBy = req.userId as any;
    doc.approvedAt = new Date();
    doc.approvalNote =
        String(req.body.note || '')
            .trim()
            .slice(0, 500) || undefined;
    await doc.save();

    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Đã phê duyệt bản tin', status: StatusCodes.OK, success: true }));
};

export const reopenDigest = async (req: Request, res: Response) => {
    const note = z.string().trim().max(500).optional().parse(req.body?.note);
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status === 'published') {
        throw new BadRequestError('Bản đã xuất bản là bất biến. Hãy tạo phiên bản mới để chỉnh sửa');
    }
    if (doc.status !== 'approved') throw new BadRequestError('Chỉ bản đã duyệt mới cần mở lại để biên tập');

    addDigestEditHistory(
        doc,
        req.userId,
        ['status'],
        {
            status: doc.status,
            approvedBy: doc.approvedBy,
            approvedAt: doc.approvedAt,
            approvalNote: doc.approvalNote,
        },
        note || 'Mở lại bản tin để biên tập'
    );
    doc.status = 'draft';
    doc.set('approvedBy', undefined);
    doc.set('approvedAt', undefined);
    doc.set('approvalNote', undefined);
    doc.set('artifact', { status: 'none' });
    doc.set('delivery', undefined);
    refreshDigestValidation(doc);
    await doc.save();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: doc,
            message: 'Đã mở lại bản tin để biên tập',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const publishDigest = async (req: Request, res: Response) => {
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status !== 'approved') throw new BadRequestError('Bản tin phải được phê duyệt trước khi xuất bản');

    const approvedChecksum = doc.validation?.checksum;
    const currentChecksum = getDigestChecksum(toPlainDigest(doc));
    const validation = refreshDigestValidation(doc);
    if (validation.status === 'blocked' || !approvedChecksum || approvedChecksum !== currentChecksum) {
        await doc.save();
        throw new BadRequestError('Nội dung đã thay đổi hoặc chưa đạt kiểm tra. Hãy kiểm tra và phê duyệt lại');
    }

    const generatingAt = doc.artifact?.generatedAt ? new Date(doc.artifact.generatedAt).getTime() : 0;
    if (doc.artifact?.status === 'generating' && Date.now() - generatingAt < 2 * 60 * 1000) {
        throw new BadRequestError('PDF chính thức đang được tạo, vui lòng chờ trong ít phút');
    }

    doc.set('artifact', {
        status: 'generating',
        checksum: validation.checksum,
        version: Number(doc.version || 1),
        contentRevision: Number(doc.contentRevision || 0),
        generatedAt: new Date(),
    });
    await doc.save();

    try {
        const artifact = await createDigestPdfArtifact(toPlainDigest(doc));
        doc.set('artifact', artifact);
    } catch (error) {
        doc.set('artifact', {
            status: 'failed',
            checksum: validation.checksum,
            version: Number(doc.version || 1),
            contentRevision: Number(doc.contentRevision || 0),
            generatedAt: new Date(),
            error: (error instanceof Error ? error.message : 'Không tạo được PDF chính thức').slice(0, 500),
        });
        await doc.save();
        throw new BadRequestError('Không tạo được PDF chính thức. Bản tin vẫn ở trạng thái đã duyệt để thử lại');
    }

    doc.status = 'published';
    doc.publishedBy = req.userId as any;
    doc.publishedAt = new Date();
    await doc.save();
    const delivery = await notifyDirectors(doc, 'published');
    doc.set('delivery', delivery);
    await doc.save();

    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Đã xuất bản bản tin', status: StatusCodes.OK, success: true }));
};

export const recordDigestView = async (req: Request, res: Response) => {
    const doc = await getDigestOrThrow(String(req.params.id));
    if (doc.status !== 'published') throw new BadRequestError('Chỉ ghi nhận lượt xem cho bản tin đã xuất bản');
    if (!req.userId) throw new BadRequestError('Không xác định được người xem');

    const now = new Date();
    const receipts = Array.isArray(doc.viewReceipts)
        ? doc.viewReceipts.map((entry: any) => (typeof entry?.toObject === 'function' ? entry.toObject() : entry))
        : [];
    const index = receipts.findIndex((entry: any) => String(entry.userId?._id || entry.userId) === String(req.userId));
    if (index >= 0) {
        const lastViewedAt = new Date(receipts[index].lastViewedAt || 0).getTime();
        receipts[index].lastViewedAt = now;
        if (Date.now() - lastViewedAt >= 5 * 60 * 1000) {
            receipts[index].viewCount = Number(receipts[index].viewCount || 1) + 1;
        }
    } else {
        receipts.push({ userId: req.userId, firstViewedAt: now, lastViewedAt: now, viewCount: 1 });
    }
    doc.set('viewReceipts', receipts);
    await doc.save();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                uniqueViewers: receipts.length,
                totalViews: receipts.reduce((sum: number, item: any) => sum + Number(item.viewCount || 0), 0),
            },
            message: 'Đã ghi nhận lượt xem',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const downloadDigestPdfFile = async (req: Request, res: Response) => {
    const doc = await getDigestOrThrow(String(req.params.id));
    const requestedVersion = req.query.version === undefined ? undefined : Number(req.query.version);
    if (requestedVersion !== undefined && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
        throw new BadRequestError('Phiên bản PDF không hợp lệ');
    }

    let artifact: any = toPlainDigest(doc.artifact);
    if (requestedVersion !== undefined && requestedVersion !== Number(doc.version || 1)) {
        const revision = (doc.revisionHistory || []).find((item: any) => Number(item.version) === requestedVersion);
        if (!revision) throw new NotFoundError('Không tìm thấy phiên bản bản tin đã chọn');
        artifact = toPlainDigest(revision.artifact);
    }
    if (!artifact || artifact.status !== 'ready') {
        throw new NotFoundError('Phiên bản này chưa có PDF chính thức');
    }

    const buffer = await downloadDigestPdf(artifact);
    const fileName = String(artifact.fileName || `ban-tin-${doc.periodKey}.pdf`).replace(/[\r\n"]/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(StatusCodes.OK).send(buffer);
};
