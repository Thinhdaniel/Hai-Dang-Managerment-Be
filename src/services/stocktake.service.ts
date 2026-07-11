import StocktakeSession from '@/models/StocktakeSession';
import Asset from '@/models/Asset';
import FloorMapRevision from '@/models/FloorMapRevision';
import FloorZone from '@/models/FloorZone';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { getPagination } from '@/utils/pagination';
import { sendSerializedItem, sendSerializedPage } from './service.helpers';
import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const toId = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const toIso = (value: any) => (value ? new Date(value).toISOString() : undefined);

const serializeStocktakeSession = (input: any) => {
    const item = typeof input?.toObject === 'function' ? input.toObject() : input;
    const plant = item?.plantId && typeof item.plantId === 'object' ? item.plantId : undefined;
    const creator = item?.createdBy && typeof item.createdBy === 'object' ? item.createdBy : undefined;

    return {
        id: toId(item),
        plantId: plant ? toId(plant) : toId(item?.plantId),
        plantName: item?.plantName || plant?.name,
        plant: plant
            ? {
                  id: toId(plant),
                  name: plant.name,
                  code: plant.code,
              }
            : undefined,
        area: item?.area,
        areaLabel: item?.areaLabel,
        captureMode: item?.captureMode || 'single',
        scannerEngine: item?.scannerEngine,
        detectedCodeCount: item?.detectedCodeCount ?? item?.scannedCount ?? 0,
        duplicateScanCount: item?.duplicateScanCount ?? 0,
        coveragePercent: item?.coveragePercent ?? 0,
        coverageCompletedCount: item?.coverageCompletedCount ?? 0,
        coverageZones: Array.isArray(item?.coverageZones)
            ? item.coverageZones.map((zone: any) => ({
                  zoneId: toId(zone.zoneId),
                  name: zone.name,
                  anchorCode: zone.anchorCode,
                  x: zone.x,
                  y: zone.y,
                  w: zone.w,
                  h: zone.h,
                  status: zone.status,
                  activationSource: zone.activationSource,
                  expectedCount: zone.expectedCount ?? 0,
                  scannedCount: zone.scannedCount ?? 0,
                  startedAt: toIso(zone.startedAt),
                  completedAt: toIso(zone.completedAt),
              }))
            : [],
        positionProposals: Array.isArray(item?.positionProposals)
            ? item.positionProposals.map((proposal: any) => ({
                  assetId: toId(proposal.assetId),
                  machineCode: proposal.machineCode,
                  name: proposal.name,
                  zoneId: toId(proposal.zoneId),
                  zoneName: proposal.zoneName,
                  currentX: proposal.currentX,
                  currentY: proposal.currentY,
                  proposedX: proposal.proposedX,
                  proposedY: proposal.proposedY,
                  assetUpdatedAt: toIso(proposal.assetUpdatedAt),
                  scannedAt: toIso(proposal.scannedAt),
                  confidence: proposal.confidence,
                  basis: proposal.basis || 'scan_order',
                  status: proposal.status || 'pending',
                  conflictReason: proposal.conflictReason,
                  reviewedBy: toId(proposal.reviewedBy),
                  reviewedAt: toIso(proposal.reviewedAt),
                  reviewNote: proposal.reviewNote,
              }))
            : [],
        startedAt: toIso(item?.startedAt),
        finishedAt: toIso(item?.finishedAt),
        expectedCount: item?.expectedCount ?? 0,
        scannedCount: item?.scannedCount ?? 0,
        presentCount: item?.presentCount ?? 0,
        missingCount: item?.missingCount ?? 0,
        anomalyCount: item?.anomalyCount ?? 0,
        items: Array.isArray(item?.items)
            ? item.items.map((row: any) => ({
                  type: row.type,
                  assetId: toId(row.assetId),
                  rawValue: row.rawValue,
                  machineCode: row.machineCode,
                  name: row.name,
                  plantName: row.plantName,
                  area: row.area,
                  status: row.status,
                  message: row.message,
                  gpsNote: row.gpsNote,
                  scannedAt: toIso(row.scannedAt),
                  coverageZoneId: toId(row.coverageZoneId),
                  coverageZoneName: row.coverageZoneName,
              }))
            : [],
        createdBy: creator ? toId(creator) : toId(item?.createdBy),
        createdByName: creator?.fullname || creator?.username || creator?.email,
        createdAt: toIso(item?.createdAt),
        updatedAt: toIso(item?.updatedAt),
    };
};

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, unknown> = {};
    if (query.plantId) filter.plantId = query.plantId;

    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) (filter.createdAt as Record<string, Date>).$gte = new Date(String(query.startDate));
        if (query.endDate) {
            const endDate = new Date(String(query.endDate));
            endDate.setHours(23, 59, 59, 999);
            (filter.createdAt as Record<string, Date>).$lte = endDate;
        }
    }

    return filter;
};

export const createStocktakeSession = async (req: Request, res: Response, next: NextFunction) => {
    const completedZones = new Map(
        (req.body.coverageZones ?? [])
            .filter((zone: any) => zone.status === 'completed' && zone.zoneId)
            .map((zone: any) => [String(zone.zoneId), zone])
    );
    const scanEvidence = new Map(
        (req.body.items ?? [])
            .filter((row: any) => row.assetId && row.coverageZoneId && row.type !== 'missing' && row.type !== 'unknown')
            .map((row: any) => [`${row.assetId}:${row.coverageZoneId}`, row])
    );
    const requestedProposals = req.body.positionProposals ?? [];
    const proposalAssetIds = Array.from(new Set(requestedProposals.map((proposal: any) => String(proposal.assetId))));
    const proposalAssets = proposalAssetIds.length
        ? await Asset.find({
              _id: { $in: proposalAssetIds },
              plantId: req.body.plantId,
              isDeleted: { $ne: true },
          }).select('machineCode name floorPos updatedAt')
        : [];
    const proposalAssetById = new Map(proposalAssets.map((asset: any) => [String(asset._id), asset]));
    const acceptedAssetIds = new Set<string>();
    const positionProposals = requestedProposals.flatMap((proposal: any) => {
        const assetId = String(proposal.assetId);
        const zoneId = String(proposal.zoneId);
        const zone: any = completedZones.get(zoneId);
        const evidence: any = scanEvidence.get(`${assetId}:${zoneId}`);
        const asset: any = proposalAssetById.get(assetId);
        const insideZone =
            zone &&
            proposal.proposedX >= zone.x &&
            proposal.proposedX <= zone.x + zone.w &&
            proposal.proposedY >= zone.y &&
            proposal.proposedY <= zone.y + zone.h;
        if (!asset || !evidence || !insideZone || acceptedAssetIds.has(assetId)) return [];
        acceptedAssetIds.add(assetId);
        return [
            {
                ...proposal,
                machineCode: asset.machineCode,
                name: asset.name,
                currentX: asset.floorPos?.x,
                currentY: asset.floorPos?.y,
                assetUpdatedAt: asset.updatedAt,
                scannedAt: evidence.scannedAt || proposal.scannedAt,
                status: 'pending',
            },
        ];
    });

    const item = await StocktakeSession.create({
        ...req.body,
        positionProposals,
        createdBy: req.userId,
    });

    const createdItem = await StocktakeSession.findById(item._id)
        .populate('plantId', 'name code')
        .populate('createdBy', 'fullname username email');

    void import('@/services/reality-operations.service')
        .then(({ evaluatePlantRealityOperations }) =>
            evaluatePlantRealityOperations(String(item.plantId), { notify: true })
        )
        .catch((error) => console.error('[RealityOperations] Background evaluation failed:', error));

    return sendSerializedItem(
        res,
        createdItem,
        serializeStocktakeSession,
        'Da luu lich su kiem ke',
        StatusCodes.CREATED
    );
};

export const getStocktakeSessions = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [items, total] = await Promise.all([
        StocktakeSession.find(filter)
            .populate('plantId', 'name code')
            .populate('createdBy', 'fullname username email')
            .sort('-createdAt')
            .skip(skip)
            .limit(limit),
        StocktakeSession.countDocuments(filter),
    ]);

    return sendSerializedPage(
        res,
        items,
        total,
        page,
        limit,
        serializeStocktakeSession,
        'Lay lich su kiem ke thanh cong'
    );
};

const pointInsideZone = (point: any, zone: any) =>
    point &&
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    point.x >= zone.x &&
    point.x <= zone.x + zone.w &&
    point.y >= zone.y &&
    point.y <= zone.y + zone.h;

const findAvailableZoneSlot = (zone: any, occupied: Array<{ x: number; y: number }>) => {
    const targetSlots = Math.max(24, (occupied.length + 1) * 4);
    const aspect = Math.max(0.35, zone.w / Math.max(zone.h, 1));
    const columns = Math.max(2, Math.ceil(Math.sqrt(targetSlots * aspect)));
    const rows = Math.max(2, Math.ceil(targetSlots / columns));
    const cellWidth = zone.w / columns;
    const cellHeight = zone.h / rows;
    const clearance = Math.max(0.35, Math.min(cellWidth, cellHeight) * 0.55);
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const slot = {
                x: Number((zone.x + cellWidth * (column + 0.5)).toFixed(3)),
                y: Number((zone.y + cellHeight * (row + 0.5)).toFixed(3)),
            };
            if (!occupied.some((point) => Math.hypot(point.x - slot.x, point.y - slot.y) < clearance)) {
                return slot;
            }
        }
    }
    return undefined;
};

export const createStocktakeDriftProposal = async (req: Request, res: Response) => {
    const session = await StocktakeSession.findById(req.params.id);
    if (!session) throw new NotFoundError('Khong tim thay phien kiem ke');
    const assetId = String(req.body.assetId);
    const evidence: any = [...(session.items ?? [])]
        .filter(
            (item: any) =>
                String(item.assetId ?? '') === assetId &&
                item.coverageZoneId &&
                !['missing', 'unknown'].includes(item.type)
        )
        .sort(
            (left: any, right: any) =>
                new Date(right.scannedAt ?? session.createdAt).getTime() -
                new Date(left.scannedAt ?? session.createdAt).getTime()
        )[0];
    if (!evidence) throw new BadRequestError('Phien kiem ke khong co bang chung vung cua may nay');
    const coverageZone: any = (session.coverageZones ?? []).find(
        (zone: any) => String(zone.zoneId ?? '') === String(evidence.coverageZoneId)
    );
    if (!coverageZone || coverageZone.status !== 'completed') {
        throw new BadRequestError('Vung quan sat chua duoc xac nhan hoan tat');
    }
    if ((session.positionProposals ?? []).some((proposal: any) => String(proposal.assetId) === assetId)) {
        throw new BadRequestError('May da co de xuat vi tri trong phien kiem ke nay');
    }

    const [asset, zone, plantAssets] = await Promise.all([
        Asset.findOne({
            _id: assetId,
            plantId: session.plantId,
            isDeleted: { $ne: true },
        }).select('machineCode name floorPos updatedAt'),
        FloorZone.findOne({ _id: evidence.coverageZoneId, plantId: session.plantId }).lean(),
        Asset.find({
            plantId: session.plantId,
            isDeleted: { $ne: true },
            'floorPos.x': { $exists: true },
            'floorPos.y': { $exists: true },
        })
            .select('floorPos')
            .lean(),
    ]);
    if (!asset) throw new NotFoundError('May khong con thuoc co so cua phien kiem ke');
    if (!zone) throw new NotFoundError('Khu vuc quan sat khong con ton tai tren so do');
    if (pointInsideZone(asset.floorPos, zone)) throw new BadRequestError('May dang nam dung trong vung da quan sat');

    const occupied = plantAssets
        .map((item: any) => item.floorPos)
        .filter((position: any) => pointInsideZone(position, zone));
    const slot = findAvailableZoneSlot(zone, occupied);
    if (!slot) throw new BadRequestError('Khu vuc khong con vi tri trong phu hop de tao de xuat');
    const confidence =
        coverageZone.activationSource === 'anchor' ? 0.92 : coverageZone.activationSource === 'manual' ? 0.78 : 0.68;
    const proposal = {
        assetId: asset._id,
        machineCode: asset.machineCode,
        name: asset.name,
        zoneId: zone._id,
        zoneName: zone.name,
        currentX: asset.floorPos?.x,
        currentY: asset.floorPos?.y,
        proposedX: slot.x,
        proposedY: slot.y,
        assetUpdatedAt: asset.updatedAt,
        scannedAt: evidence.scannedAt || session.createdAt,
        confidence,
        basis: 'scan_order',
        status: 'pending',
    };
    session.positionProposals.push(proposal as any);
    await session.save();
    void import('@/services/reality-operations.service')
        .then(({ evaluatePlantRealityOperations }) =>
            evaluatePlantRealityOperations(String(session.plantId), { notify: true })
        )
        .catch((error) => console.error('[RealityOperations] Background evaluation failed:', error));

    return res.status(StatusCodes.CREATED).json({
        proposal: {
            ...proposal,
            assetId: String(proposal.assetId),
            zoneId: String(proposal.zoneId),
            assetUpdatedAt: proposal.assetUpdatedAt.toISOString(),
            scannedAt: new Date(proposal.scannedAt).toISOString(),
        },
    });
};

const sameCoordinate = (left: unknown, right: unknown) => {
    if (left === undefined && right === undefined) return true;
    if (typeof left !== 'number' || typeof right !== 'number') return false;
    return Math.abs(left - right) < 0.0001;
};

export const reviewStocktakePositionProposals = async (req: Request, res: Response) => {
    const session = await StocktakeSession.findById(req.params.id);
    if (!session) throw new NotFoundError('Khong tim thay phien kiem ke');

    const requestedIds = new Set<string>(req.body.assetIds.map(String));
    const proposals = (session.positionProposals ?? []).filter((proposal: any) =>
        requestedIds.has(String(proposal.assetId))
    );
    if (!proposals.length) throw new BadRequestError('Khong co de xuat vi tri phu hop');

    const reviewable = proposals.filter((proposal: any) =>
        req.body.action === 'reject' ? ['pending', 'conflict'].includes(proposal.status) : proposal.status === 'pending'
    );
    if (!reviewable.length) throw new BadRequestError('Cac de xuat da duoc xu ly truoc do');

    const now = new Date();
    if (req.body.action === 'reject') {
        reviewable.forEach((proposal: any) => {
            proposal.status = 'rejected';
            proposal.reviewedBy = req.userId;
            proposal.reviewedAt = now;
            proposal.reviewNote = req.body.note;
            proposal.conflictReason = undefined;
        });
    } else {
        const assets = await Asset.find({
            _id: { $in: reviewable.map((proposal: any) => proposal.assetId) },
            isDeleted: { $ne: true },
        }).select('plantId floorPos updatedAt');
        const assetById = new Map(assets.map((asset: any) => [String(asset._id), asset]));
        const safe: any[] = [];

        reviewable.forEach((proposal: any) => {
            const asset: any = assetById.get(String(proposal.assetId));
            let conflictReason = '';
            if (!asset) conflictReason = 'Máy không còn tồn tại hoặc đã bị xóa';
            else if (String(asset.plantId) !== String(session.plantId))
                conflictReason = 'Máy đã chuyển sang cơ sở khác';
            else if (
                !sameCoordinate(asset.floorPos?.x, proposal.currentX) ||
                !sameCoordinate(asset.floorPos?.y, proposal.currentY)
            ) {
                conflictReason = 'Tọa độ máy đã thay đổi sau khi tạo đề xuất';
            } else if (new Date(asset.updatedAt).getTime() > new Date(proposal.assetUpdatedAt).getTime() + 1000) {
                conflictReason = 'Thông tin máy đã được cập nhật sau phiên kiểm kê';
            }

            proposal.reviewedBy = req.userId;
            proposal.reviewedAt = now;
            proposal.reviewNote = req.body.note;
            if (conflictReason) {
                proposal.status = 'conflict';
                proposal.conflictReason = conflictReason;
            } else {
                safe.push(proposal);
            }
        });

        if (safe.length) {
            const revisionChanges: any[] = [];
            await Promise.all(
                safe.map(async (proposal: any) => {
                    const floorCondition =
                        typeof proposal.currentX === 'number' && typeof proposal.currentY === 'number'
                            ? { 'floorPos.x': proposal.currentX, 'floorPos.y': proposal.currentY }
                            : {
                                  $or: [{ 'floorPos.x': { $exists: false } }, { 'floorPos.y': { $exists: false } }],
                              };
                    const updated = await Asset.findOneAndUpdate(
                        {
                            _id: proposal.assetId,
                            plantId: session.plantId,
                            isDeleted: { $ne: true },
                            updatedAt: proposal.assetUpdatedAt,
                            ...floorCondition,
                        },
                        {
                            $set: {
                                floorPos: { x: proposal.proposedX, y: proposal.proposedY },
                                updatedBy: req.userId,
                            },
                        },
                        { new: true }
                    );
                    if (updated) {
                        proposal.status = 'approved';
                        proposal.conflictReason = undefined;
                        revisionChanges.push({
                            assetId: proposal.assetId,
                            machineCode: proposal.machineCode,
                            name: proposal.name,
                            before:
                                typeof proposal.currentX === 'number' && typeof proposal.currentY === 'number'
                                    ? { x: proposal.currentX, y: proposal.currentY }
                                    : null,
                            after: { x: proposal.proposedX, y: proposal.proposedY },
                        });
                    } else {
                        proposal.status = 'conflict';
                        proposal.conflictReason = 'Dữ liệu máy vừa thay đổi trong lúc phê duyệt';
                    }
                })
            );
            if (revisionChanges.length) {
                await FloorMapRevision.create({
                    plantId: session.plantId,
                    source: 'stocktake',
                    stocktakeSessionId: session._id,
                    changedBy: req.userId,
                    changes: revisionChanges,
                });
            }
        }
    }

    await session.save();
    void import('@/services/reality-operations.service')
        .then(({ evaluatePlantRealityOperations }) =>
            evaluatePlantRealityOperations(String(session.plantId), { notify: true })
        )
        .catch((error) => console.error('[RealityOperations] Background evaluation failed:', error));
    const refreshed = await StocktakeSession.findById(session._id)
        .populate('plantId', 'name code')
        .populate('createdBy', 'fullname username email');
    const approved = reviewable.filter((proposal: any) => proposal.status === 'approved').length;
    const rejected = reviewable.filter((proposal: any) => proposal.status === 'rejected').length;
    const conflicts = reviewable.filter((proposal: any) => proposal.status === 'conflict').length;

    // Tra thang data (chuan customResponse) — FE doc result.session/result.summary o top-level
    return res.status(StatusCodes.OK).json({
        session: serializeStocktakeSession(refreshed),
        summary: { approved, rejected, conflicts },
    });
};
