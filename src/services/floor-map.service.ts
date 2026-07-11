import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import Asset from '@/models/Asset';
import FloorZone from '@/models/FloorZone';
import FloorMapRevision from '@/models/FloorMapRevision';
import StocktakeSession from '@/models/StocktakeSession';
import Maintenance from '@/models/Maintenance';
import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import customResponse from '@/utils/response';

// Sơ đồ mặt bằng xưởng: khu vực (FloorZone) + vị trí máy (asset.floorPos), toạ độ % 0-100.
// Trạng thái máy trên sơ đồ cập nhật real-time qua sự kiện socket asset:updated sẵn có.

const EXCLUDED_STATUSES = [ASSET_STATUS.DISPOSED, ASSET_STATUS.RETURNED_TO_PARTNER];

const serializeZone = (zone: any) => ({
    id: String(zone._id),
    name: zone.name,
    anchorCode: zone.anchorCode,
    x: zone.x,
    y: zone.y,
    w: zone.w,
    h: zone.h,
});

const requirePlantId = (value: unknown): string => {
    const plantId = String(value ?? '');
    if (!mongoose.isValidObjectId(plantId)) {
        throw new BadRequestError('Thieu hoac sai plantId');
    }
    return plantId;
};

export const getFloorMap = async (req: Request, res: Response) => {
    const plantId = requirePlantId(req.query.plantId);

    // Backfill mot lan cho cac zone tao truoc Phase 2. Ma anchor on dinh, khong doi khi sua ten/toa do zone.
    const zonesWithoutAnchor = await FloorZone.find({
        plantId,
        $or: [{ anchorCode: { $exists: false } }, { anchorCode: null }, { anchorCode: '' }],
    })
        .select('_id')
        .lean();
    if (zonesWithoutAnchor.length) {
        await FloorZone.bulkWrite(
            zonesWithoutAnchor.map((zone) => ({
                updateOne: {
                    filter: { _id: zone._id },
                    update: { $set: { anchorCode: `ZN-${nanoid(10).toUpperCase()}` } },
                },
            }))
        );
    }

    const [zones, machines] = await Promise.all([
        FloorZone.find({ plantId }).sort({ createdAt: 1 }).lean(),
        Asset.find({
            plantId,
            isDeleted: { $ne: true },
            status: { $nin: EXCLUDED_STATUSES },
        })
            .select('name machineCode type status area floorPos')
            .sort({ machineCode: 1 })
            .lean(),
    ]);

    // Nhiệt sự cố: đếm số phiếu hỏng đột xuất (emergency) 6 tháng gần nhất theo máy
    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    const machineIds = machines.map((m) => m._id);
    const incidentRows: { _id: mongoose.Types.ObjectId; count: number }[] = machineIds.length
        ? await Maintenance.aggregate([
              {
                  $match: {
                      isDeleted: { $ne: true },
                      status: { $ne: 'cancelled' },
                      type: 'emergency',
                      startDate: { $gte: since },
                      assetIds: { $in: machineIds },
                  },
              },
              { $unwind: '$assetIds' },
              { $match: { assetIds: { $in: machineIds } } },
              { $group: { _id: '$assetIds', count: { $sum: 1 } } },
          ])
        : [];
    const incidentMap = new Map(incidentRows.map((row) => [String(row._id), row.count]));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                zones: zones.map(serializeZone),
                machines: machines.map((m) => ({
                    id: String(m._id),
                    name: m.name,
                    machineCode: m.machineCode,
                    type: m.type,
                    status: m.status,
                    area: m.area ?? '',
                    incidents6m: incidentMap.get(String(m._id)) ?? 0,
                    floorPos:
                        m.floorPos && typeof m.floorPos.x === 'number' && typeof m.floorPos.y === 'number'
                            ? { x: m.floorPos.x, y: m.floorPos.y }
                            : null,
                })),
            },
            message: 'Lay so do xuong thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

type RealityStatus = 'verified' | 'drift' | 'unplaced' | 'stale' | 'unverified';

const REALITY_SCORE: Record<RealityStatus, number> = {
    verified: 100,
    stale: 55,
    unplaced: 25,
    drift: 15,
    unverified: 0,
};

const pointInZone = (position: any, zone: any) =>
    position &&
    typeof position.x === 'number' &&
    typeof position.y === 'number' &&
    position.x >= zone.x &&
    position.x <= zone.x + zone.w &&
    position.y >= zone.y &&
    position.y <= zone.y + zone.h;

export const buildFloorMapRealityHealth = async (plantIdInput: string, staleDaysInput = 30) => {
    const plantId = requirePlantId(plantIdInput);
    const staleDays = Math.min(Math.max(Number(staleDaysInput) || 30, 7), 180);
    const plantObjectId = new mongoose.Types.ObjectId(plantId);
    const [zones, machines, evidenceRows, latestSession] = await Promise.all([
        FloorZone.find({ plantId }).sort({ createdAt: 1 }).lean(),
        Asset.find({
            plantId,
            isDeleted: { $ne: true },
            status: { $nin: EXCLUDED_STATUSES },
        })
            .select('name machineCode type status area floorPos')
            .sort({ machineCode: 1 })
            .lean(),
        StocktakeSession.aggregate([
            { $match: { plantId: plantObjectId } },
            { $unwind: '$items' },
            {
                $match: {
                    'items.assetId': { $ne: null },
                    'items.type': { $in: ['present', 'wrong_area'] },
                    'items.coverageZoneId': { $ne: null },
                },
            },
            {
                $set: {
                    evidenceCoverageZone: {
                        $first: {
                            $filter: {
                                input: '$coverageZones',
                                as: 'zone',
                                cond: { $eq: ['$$zone.zoneId', '$items.coverageZoneId'] },
                            },
                        },
                    },
                },
            },
            { $match: { 'evidenceCoverageZone.status': 'completed' } },
            { $addFields: { evidenceAt: { $ifNull: ['$items.scannedAt', '$createdAt'] } } },
            { $sort: { evidenceAt: -1, createdAt: -1 } },
            {
                $group: {
                    _id: '$items.assetId',
                    sessionId: { $first: '$_id' },
                    scannedAt: { $first: '$evidenceAt' },
                    coverageZoneId: { $first: '$items.coverageZoneId' },
                    coverageZoneName: {
                        $first: { $ifNull: ['$items.coverageZoneName', '$evidenceCoverageZone.name'] },
                    },
                    captureMode: { $first: '$captureMode' },
                    createdBy: { $first: '$createdBy' },
                    positionProposals: { $first: '$positionProposals' },
                },
            },
            {
                $set: {
                    existingProposal: {
                        $first: {
                            $filter: {
                                input: '$positionProposals',
                                as: 'proposal',
                                cond: { $eq: ['$$proposal.assetId', '$_id'] },
                            },
                        },
                    },
                },
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'createdBy',
                    foreignField: '_id',
                    as: 'creator',
                },
            },
            { $set: { creator: { $first: '$creator' } } },
            {
                $project: {
                    sessionId: 1,
                    scannedAt: 1,
                    coverageZoneId: 1,
                    coverageZoneName: 1,
                    captureMode: 1,
                    proposalStatus: '$existingProposal.status',
                    createdByName: {
                        $ifNull: ['$creator.fullname', { $ifNull: ['$creator.username', '$creator.email'] }],
                    },
                },
            },
        ]),
        StocktakeSession.findOne({ plantId })
            .select('createdAt coveragePercent coverageCompletedCount coverageZones createdBy')
            .populate('createdBy', 'fullname username email')
            .sort('-createdAt')
            .lean(),
    ]);

    const zoneById = new Map(zones.map((zone: any) => [String(zone._id), zone]));
    const evidenceByAssetId = new Map(evidenceRows.map((row: any) => [String(row._id), row]));
    const now = Date.now();
    const statusCounts: Record<RealityStatus, number> = {
        verified: 0,
        drift: 0,
        unplaced: 0,
        stale: 0,
        unverified: 0,
    };

    const machineHealth = machines.map((machine: any) => {
        const evidence: any = evidenceByAssetId.get(String(machine._id));
        const currentZone = machine.floorPos
            ? zones
                  .filter((zone: any) => pointInZone(machine.floorPos, zone))
                  .sort((left: any, right: any) => left.w * left.h - right.w * right.h)[0]
            : undefined;
        const observedZone = evidence?.coverageZoneId ? zoneById.get(String(evidence.coverageZoneId)) : undefined;
        const scannedAt = evidence?.scannedAt ? new Date(evidence.scannedAt) : undefined;
        const ageDays = scannedAt ? Math.max(0, Math.floor((now - scannedAt.getTime()) / 86_400_000)) : undefined;
        let realityStatus: RealityStatus = 'unverified';
        if (evidence && observedZone && !machine.floorPos) realityStatus = 'unplaced';
        else if (evidence && observedZone && String(currentZone?._id ?? '') !== String(observedZone._id)) {
            realityStatus = 'drift';
        } else if (evidence && observedZone && typeof ageDays === 'number' && ageDays > staleDays) {
            realityStatus = 'stale';
        } else if (evidence && observedZone && currentZone) realityStatus = 'verified';
        statusCounts[realityStatus] += 1;

        return {
            assetId: String(machine._id),
            machineCode: machine.machineCode,
            name: machine.name,
            floorPos:
                machine.floorPos && typeof machine.floorPos.x === 'number' && typeof machine.floorPos.y === 'number'
                    ? { x: machine.floorPos.x, y: machine.floorPos.y }
                    : null,
            status: realityStatus,
            score: REALITY_SCORE[realityStatus],
            currentZone: currentZone ? { id: String(currentZone._id), name: currentZone.name } : undefined,
            evidence: evidence
                ? {
                      sessionId: String(evidence.sessionId),
                      scannedAt: scannedAt?.toISOString(),
                      ageDays,
                      zoneId: evidence.coverageZoneId ? String(evidence.coverageZoneId) : undefined,
                      zoneName: evidence.coverageZoneName,
                      captureMode: evidence.captureMode,
                      createdByName: evidence.createdByName,
                      proposalStatus: evidence.proposalStatus,
                  }
                : undefined,
        };
    });

    const zoneHealth = zones.map((zone: any) => {
        const relevant = machineHealth.filter(
            (machine) =>
                machine.currentZone?.id === String(zone._id) ||
                (!machine.currentZone && machine.evidence?.zoneId === String(zone._id))
        );
        const counts = {
            verified: relevant.filter((item) => item.status === 'verified').length,
            drift: relevant.filter((item) => item.status === 'drift').length,
            unplaced: relevant.filter((item) => item.status === 'unplaced').length,
            stale: relevant.filter((item) => item.status === 'stale').length,
            unverified: relevant.filter((item) => item.status === 'unverified').length,
        };
        return {
            zoneId: String(zone._id),
            zoneName: zone.name,
            anchorCode: zone.anchorCode,
            total: relevant.length,
            score: relevant.length
                ? Math.round(relevant.reduce((sum, item) => sum + item.score, 0) / relevant.length)
                : 0,
            counts,
        };
    });
    const score = machineHealth.length
        ? Math.round(machineHealth.reduce((sum, machine) => sum + machine.score, 0) / machineHealth.length)
        : 0;
    const creator: any = latestSession?.createdBy;

    return {
        generatedAt: new Date().toISOString(),
        staleDays,
        score,
        total: machineHealth.length,
        counts: statusCounts,
        machines: machineHealth,
        zones: zoneHealth,
        latestSession: latestSession
            ? {
                  id: String(latestSession._id),
                  createdAt: latestSession.createdAt?.toISOString(),
                  coveragePercent: latestSession.coveragePercent ?? 0,
                  coverageCompletedCount: latestSession.coverageCompletedCount ?? 0,
                  coverageZoneCount: latestSession.coverageZones?.length ?? 0,
                  createdByName: creator?.fullname || creator?.username || creator?.email,
              }
            : undefined,
    };
};

export const getFloorMapRealityHealth = async (req: Request, res: Response) => {
    const result = await buildFloorMapRealityHealth(String(req.query.plantId ?? ''), Number(req.query.staleDays));
    return res.status(StatusCodes.OK).json(result);
};

export const resolveFloorZoneAnchor = async (req: Request, res: Response) => {
    const anchorCode = String(req.params.code ?? '')
        .trim()
        .toUpperCase();
    if (!/^ZN-[A-Z0-9_-]{6,32}$/.test(anchorCode)) throw new BadRequestError('Ma QR khu vuc khong hop le');

    const zone = await FloorZone.findOne({ anchorCode }).populate('plantId', 'name code').lean();
    if (!zone) throw new NotFoundError('Khong tim thay khu vuc cua ma QR');
    const plant = zone.plantId as any;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                zone: serializeZone(zone),
                plant: {
                    id: String(plant?._id ?? zone.plantId),
                    name: plant?.name,
                    code: plant?.code,
                },
            },
            message: 'Nhan dien QR khu vuc thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// Chi phí bảo trì theo phiếu — cùng công thức với report.service (cost ?? actualCost ?? tổng costItems)
const getMaintenanceCost = (item: any) => {
    const costItemsTotal = (item.externalRepair?.costItems ?? []).reduce(
        (sum: number, costItem: any) => sum + Number(costItem.amount ?? 0),
        0
    );
    return Number(item.cost ?? item.externalRepair?.actualCost ?? costItemsTotal ?? 0);
};

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Thống kê 1 máy cho panel chi tiết trên sơ đồ: chi phí sửa 12 tháng theo tháng + lần hỏng 6 tháng
export const getFloorMachineStats = async (req: Request, res: Response) => {
    const assetId = String(req.params.id);
    if (!mongoose.isValidObjectId(assetId)) throw new BadRequestError('Sai id may');

    const asset = await Asset.findOne({ _id: assetId, isDeleted: { $ne: true } })
        .select('_id lastMaintenanceDate')
        .lean();
    if (!asset) throw new NotFoundError('Khong tim thay may');

    const since12m = new Date();
    since12m.setMonth(since12m.getMonth() - 11);
    since12m.setDate(1);
    since12m.setHours(0, 0, 0, 0);
    const since6m = new Date();
    since6m.setMonth(since6m.getMonth() - 6);

    const tickets = await Maintenance.find({
        isDeleted: { $ne: true },
        status: { $ne: 'cancelled' },
        $or: [{ assetId: asset._id }, { assetIds: asset._id }],
        startDate: { $gte: since12m },
    })
        .select('type startDate cost externalRepair.actualCost externalRepair.costItems assetIds')
        .lean();

    // Khung 12 tháng liên tục (kể cả tháng 0đ) để sparkline không bị đứt trục thời gian
    const months: { ym: string; cost: number }[] = [];
    const cursor = new Date(since12m);
    for (let i = 0; i < 12; i++) {
        months.push({ ym: monthKey(cursor), cost: 0 });
        cursor.setMonth(cursor.getMonth() + 1);
    }
    const monthIndex = new Map(months.map((m, i) => [m.ym, i]));

    let incidents6m = 0;
    for (const ticket of tickets) {
        const started = new Date(ticket.startDate);
        // Phiếu nhiều máy: chia đều chi phí cho số máy trong phiếu
        const shareCount = Math.max(ticket.assetIds?.length ?? 1, 1);
        const idx = monthIndex.get(monthKey(started));
        if (idx !== undefined) months[idx].cost += getMaintenanceCost(ticket) / shareCount;
        if (ticket.type === 'emergency' && started >= since6m) incidents6m += 1;
    }
    months.forEach((m) => {
        m.cost = Math.round(m.cost);
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                months,
                total12m: months.reduce((sum, m) => sum + m.cost, 0),
                incidents6m,
                ticketCount12m: tickets.length,
                lastMaintenanceAt: asset.lastMaintenanceDate ?? null,
            },
            message: 'Lay thong ke may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const coord = z.number().min(0).max(100);
const optionalCoord = coord.nullable().optional();

const saveZonesSchema = z.object({
    plantId: z.string(),
    zones: z
        .array(
            z.object({
                id: z.string().optional(),
                name: z.string().trim().min(1).max(60),
                x: coord,
                y: coord,
                w: z.number().min(1).max(100),
                h: z.number().min(1).max(100),
            })
        )
        .max(40),
});

// Lưu toàn bộ khu vực của một cơ sở (thay thế trọn bộ: khu không gửi lên = xoá).
export const saveFloorZones = async (req: Request, res: Response) => {
    const parsed = saveZonesSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Du lieu khu vuc khong hop le');
    const plantId = requirePlantId(parsed.data.plantId);

    const keepIds = parsed.data.zones
        .map((zone) => zone.id)
        .filter((id): id is string => Boolean(id && mongoose.isValidObjectId(id)));

    await FloorZone.deleteMany({ plantId, _id: { $nin: keepIds } });

    const saved = [];
    for (const zone of parsed.data.zones) {
        const payload = { name: zone.name, x: zone.x, y: zone.y, w: zone.w, h: zone.h, updatedBy: req.userId };
        if (zone.id && mongoose.isValidObjectId(zone.id)) {
            const updated = await FloorZone.findOneAndUpdate(
                { _id: zone.id, plantId },
                { $set: payload },
                { new: true }
            ).lean();
            if (updated) saved.push(updated);
        } else {
            const created = await FloorZone.create({ ...payload, plantId });
            saved.push(created.toObject());
        }
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { zones: saved.map(serializeZone) },
            message: 'Luu khu vuc thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const savePositionsSchema = z.object({
    items: z
        .array(
            z.object({
                assetId: z.string(),
                // x/y = null nghĩa là gỡ máy khỏi sơ đồ
                x: coord.nullable(),
                y: coord.nullable(),
                expectedX: optionalCoord,
                expectedY: optionalCoord,
            })
        )
        .min(1)
        .max(500),
});

// Lưu vị trí hàng loạt máy trên sơ đồ (kéo-thả xong bấm Lưu một lần).
export const saveFloorPositions = async (req: Request, res: Response) => {
    const parsed = savePositionsSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Du lieu vi tri khong hop le');

    const updatedBy =
        req.userId && mongoose.isValidObjectId(req.userId)
            ? new mongoose.Types.ObjectId(String(req.userId))
            : undefined;

    const validItems = parsed.data.items.filter((item) => mongoose.isValidObjectId(item.assetId));
    if (!validItems.length) throw new BadRequestError('Khong co may hop le de cap nhat');

    const assets = await Asset.find({
        _id: { $in: validItems.map((item) => item.assetId) },
        isDeleted: { $ne: true },
    }).select('plantId machineCode name floorPos');
    const assetById = new Map(assets.map((asset: any) => [String(asset._id), asset]));
    const conflicts: string[] = [];
    const applied: Array<{
        plantId: string;
        assetId: mongoose.Types.ObjectId;
        machineCode?: string;
        name?: string;
        before: { x: number; y: number } | null;
        after: { x: number; y: number } | null;
    }> = [];

    await Promise.all(
        validItems.map(async (item) => {
            const asset: any = assetById.get(item.assetId);
            if (!asset) {
                conflicts.push(item.assetId);
                return;
            }
            const before =
                typeof asset.floorPos?.x === 'number' && typeof asset.floorPos?.y === 'number'
                    ? { x: asset.floorPos.x, y: asset.floorPos.y }
                    : null;
            const after = item.x === null || item.y === null ? null : { x: item.x, y: item.y };
            if (before?.x === after?.x && before?.y === after?.y) return;

            const hasExpected = item.expectedX !== undefined || item.expectedY !== undefined;
            const expected =
                item.expectedX === null || item.expectedY === null
                    ? null
                    : {
                          x: item.expectedX,
                          y: item.expectedY,
                      };
            if (hasExpected && (before?.x !== expected?.x || before?.y !== expected?.y)) {
                conflicts.push(item.assetId);
                return;
            }
            const currentFilter = before
                ? { 'floorPos.x': before.x, 'floorPos.y': before.y }
                : { $or: [{ 'floorPos.x': { $exists: false } }, { 'floorPos.y': { $exists: false } }] };
            const update = after
                ? { $set: { floorPos: after, updatedBy } }
                : { $unset: { floorPos: 1 }, $set: { updatedBy } };
            const changed = await Asset.findOneAndUpdate(
                { _id: asset._id, isDeleted: { $ne: true }, ...currentFilter },
                update,
                { new: true }
            );
            if (!changed) {
                conflicts.push(item.assetId);
                return;
            }
            applied.push({
                plantId: String(asset.plantId),
                assetId: asset._id,
                machineCode: asset.machineCode,
                name: asset.name,
                before,
                after,
            });
        })
    );

    const revisions = [];
    const changesByPlant = new Map<string, typeof applied>();
    applied.forEach((change) => {
        const list = changesByPlant.get(change.plantId) ?? [];
        list.push(change);
        changesByPlant.set(change.plantId, list);
    });
    for (const [plantId, changes] of changesByPlant) {
        revisions.push(
            await FloorMapRevision.create({
                plantId,
                source: 'manual',
                changedBy: updatedBy,
                changes: changes.map(({ plantId: _plantId, ...change }) => change),
            })
        );
        void import('@/services/reality-operations.service')
            .then(({ evaluatePlantRealityOperations }) => evaluatePlantRealityOperations(plantId, { notify: true }))
            .catch((error) => console.error('[RealityOperations] Background evaluation failed:', error));
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { updated: applied.length, conflicts, revisionIds: revisions.map((item) => String(item._id)) },
            message: 'Luu vi tri may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const serializeRevision = (input: any) => {
    const revision = typeof input?.toObject === 'function' ? input.toObject() : input;
    const actor = revision.changedBy && typeof revision.changedBy === 'object' ? revision.changedBy : undefined;
    const revertedBy = revision.revertedBy && typeof revision.revertedBy === 'object' ? revision.revertedBy : undefined;
    return {
        id: String(revision._id),
        plantId: String(revision.plantId?._id ?? revision.plantId),
        source: revision.source,
        stocktakeSessionId: revision.stocktakeSessionId ? String(revision.stocktakeSessionId) : undefined,
        status: revision.status,
        changedBy: actor?._id ? String(actor._id) : String(revision.changedBy),
        changedByName: actor?.fullname || actor?.username || actor?.email,
        changes: (revision.changes ?? []).map((change: any) => ({
            assetId: String(change.assetId),
            machineCode: change.machineCode,
            name: change.name,
            before: change.before ?? null,
            after: change.after ?? null,
        })),
        revertedBy: revertedBy?._id
            ? String(revertedBy._id)
            : revision.revertedBy
              ? String(revision.revertedBy)
              : undefined,
        revertedByName: revertedBy?.fullname || revertedBy?.username || revertedBy?.email,
        revertedAt: revision.revertedAt?.toISOString?.() ?? revision.revertedAt,
        conflictAssetIds: (revision.conflictAssetIds ?? []).map(String),
        createdAt: revision.createdAt?.toISOString?.() ?? revision.createdAt,
    };
};

export const getFloorMapRevisions = async (req: Request, res: Response) => {
    const plantId = requirePlantId(req.query.plantId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const revisions = await FloorMapRevision.find({ plantId })
        .populate('changedBy', 'fullname username email')
        .populate('revertedBy', 'fullname username email')
        .sort('-createdAt')
        .limit(limit);
    return res.status(StatusCodes.OK).json({ revisions: revisions.map(serializeRevision) });
};

export const rollbackFloorMapRevision = async (req: Request, res: Response) => {
    const revision = await FloorMapRevision.findById(req.params.id);
    if (!revision) throw new NotFoundError('Khong tim thay phien ban so do');
    if (revision.status !== 'applied') throw new BadRequestError('Phien ban nay da duoc hoan tac hoac xu ly truoc do');

    const conflicts: string[] = [];
    let reverted = 0;
    await Promise.all(
        revision.changes.map(async (change: any) => {
            const after = change.after as { x: number; y: number } | null;
            const before = change.before as { x: number; y: number } | null;
            const currentFilter = after
                ? { 'floorPos.x': after.x, 'floorPos.y': after.y }
                : { $or: [{ 'floorPos.x': { $exists: false } }, { 'floorPos.y': { $exists: false } }] };
            const update = before
                ? { $set: { floorPos: before, updatedBy: req.userId } }
                : { $unset: { floorPos: 1 }, $set: { updatedBy: req.userId } };
            const asset = await Asset.findOneAndUpdate(
                { _id: change.assetId, plantId: revision.plantId, isDeleted: { $ne: true }, ...currentFilter },
                update,
                { new: true }
            );
            if (asset) reverted += 1;
            else conflicts.push(String(change.assetId));
        })
    );

    revision.status = conflicts.length ? 'partial' : 'reverted';
    revision.revertedBy = new mongoose.Types.ObjectId(String(req.userId));
    revision.revertedAt = new Date();
    revision.conflictAssetIds = conflicts.map((id) => new mongoose.Types.ObjectId(id));
    await revision.save();

    return res.status(StatusCodes.OK).json({
        revision: serializeRevision(revision),
        summary: { reverted, conflicts: conflicts.length, conflictAssetIds: conflicts },
    });
};
