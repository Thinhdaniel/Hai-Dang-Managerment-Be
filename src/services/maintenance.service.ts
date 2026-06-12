import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { emitToAll } from '@/lib/socket';
import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import Plant from '@/models/Plant';
import Transfer from '@/models/Transfer';
import TransferHistory from '@/models/TransferHistory';
import { getPagination } from '@/utils/pagination';
import { serializeAsset, serializeMaintenance } from '@/utils/serializers';
import {
    WORKFLOW_POPULATE,
    applyPopulate,
    findOnePopulatedOrThrow,
    sendSerializedItem,
    sendSerializedList,
    sendSerializedPage,
    sendSuccess,
} from './service.helpers';
import { notifyAdmins, getActorName } from './notification.helper';
import { appendMaintenanceSystemMessage } from './chat.service';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const EXTERNAL_REPAIR_MODE = 'external';
const ASSET_SOCKET_EVENTS = {
    UPDATED: 'asset:updated',
} as const;

const broadcastAssetChange = (asset: unknown, action: string, changedFields: string[] = []) => {
    if (!asset) return;

    const serializedAsset = serializeAsset(asset);

    emitToAll(ASSET_SOCKET_EVENTS.UPDATED, {
        action,
        assetId: serializedAsset.id,
        asset: serializedAsset,
        changedFields,
        updatedAt: serializedAsset.updatedAt ?? new Date().toISOString(),
    });
};

// ─── Plant snapshot helper ────────────────────────────────────────────────────

type PlantSnapshot = {
    plantId?: unknown;
    plantName?: string;
    areaAtCreation?: string;
    plantSnapshotSource: 'backfilled_from_transfer_history' | 'backfilled_from_current_asset' | 'unknown';
    plantIdBackfilled: true;
};

/**
 * Thử xác định cơ sở tại thời điểm bảo trì cho record cũ thiếu snapshot.
 * Trả về null nếu record đã có plantId (không cần backfill).
 * Ưu tiên TransferHistory, fallback asset hiện tại, cuối cùng là 'unknown'.
 */
const resolveMaintenancePlantSnapshot = async (maintenance: any): Promise<PlantSnapshot | null> => {
    if (maintenance.plantId) return null;

    const assetId = maintenance.assetId?._id ?? maintenance.assetId;
    if (!assetId) {
        return { plantSnapshotSource: 'unknown', plantIdBackfilled: true };
    }

    const referenceDate: Date = maintenance.endDate ?? maintenance.startDate ?? maintenance.createdAt ?? new Date();

    const historyList = await TransferHistory.find({
        machineId: assetId,
        isDeleted: { $ne: true },
    })
        .sort({ createdAt: 1 })
        .lean();

    if (historyList.length) {
        const historiesBefore = (historyList as any[]).filter((h) => new Date(h.createdAt) <= referenceDate);

        let targetPlantId: any;
        let targetPlantName: string | undefined;

        if (historiesBefore.length) {
            // Bản ghi gần nhất trước mốc → máy đã ở toPlantId của bản ghi đó
            const latest = historiesBefore[historiesBefore.length - 1] as any;
            targetPlantId = latest.toPlantId;
            targetPlantName = latest.toPlant;
        } else {
            // Tất cả transfer đều SAU mốc → plant lúc đó = fromPlantId của transfer đầu tiên
            const earliest = historyList[0] as any;
            targetPlantId = earliest.fromPlantId;
            targetPlantName = earliest.fromPlant;
        }

        if (targetPlantId) {
            if (!targetPlantName) {
                const plant = await Plant.findById(targetPlantId).select('name').lean();
                targetPlantName = (plant as any)?.name;
            }
            return {
                plantId: targetPlantId,
                plantName: targetPlantName,
                plantSnapshotSource: 'backfilled_from_transfer_history',
                plantIdBackfilled: true,
            };
        }
    }

    // Fallback: asset.plantId hiện tại (đánh dấu để phân biệt với snapshot chính xác)
    const asset = await Asset.findById(assetId).populate('plantId').lean();
    if (asset?.plantId) {
        const assetPlant = (asset as any).plantId;
        return {
            plantId: assetPlant?._id ?? asset.plantId,
            plantName: assetPlant?.name,
            areaAtCreation: (asset as any).area,
            plantSnapshotSource: 'backfilled_from_current_asset',
            plantIdBackfilled: true,
        };
    }

    return { plantSnapshotSource: 'unknown', plantIdBackfilled: true };
};

const parseReportDateStart = (value: unknown) => {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    date.setHours(0, 0, 0, 0);
    return date;
};

const parseReportDateEnd = (value: unknown) => {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    date.setHours(23, 59, 59, 999);
    return date;
};

const getPeriodLabel = (date: Date, groupBy: string) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (groupBy === 'day') return `${year}-${month}-${day}`;
    if (groupBy === 'quarter') return `${year}-Q${Math.floor(date.getMonth() / 3) + 1}`;
    return `${year}-${month}`;
};

const calculateExternalCost = (payload: any) => {
    const externalRepair = payload?.externalRepair ?? {};
    const itemTotal = Array.isArray(externalRepair.costItems)
        ? externalRepair.costItems.reduce((sum: number, item: any) => sum + Number(item?.amount ?? 0), 0)
        : 0;
    return Number(Number(externalRepair.actualCost ?? payload?.cost ?? itemTotal ?? 0).toFixed(2));
};

const getNextAssetStatus = (asset: any) =>
    asset?.ownershipType && asset.ownershipType !== ASSET_OWNERSHIP_TYPE.OWNED
        ? ASSET_STATUS.BORROWING
        : ASSET_STATUS.ACTIVE;

const findMaintenanceForAction = async (id: string) => {
    const item = await Maintenance.findOne({ _id: id, isDeleted: { $ne: true } });
    if (!item) throw new NotFoundError('Khong tim thay phieu bao tri');
    return item;
};

const fetchPopulatedMaintenance = (id: string) =>
    findOnePopulatedOrThrow({
        model: Maintenance,
        filter: { _id: id, isDeleted: { $ne: true } },
        populate: WORKFLOW_POPULATE.maintenance,
        notFoundMessage: 'Khong tim thay phieu bao tri',
    });

const syncMaintenanceStatuses = async () => {
    await Maintenance.updateMany(
        {
            isDeleted: { $ne: true },
            status: { $in: ['pending', 'in_progress'] },
            endDate: { $lt: new Date() },
        },
        { status: 'overdue' }
    );
};

const buildFilter = async (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (query.assetId) filter.assetId = query.assetId;
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.repairMode) filter.repairMode = query.repairMode;
    if (query.approvalStatus) filter.approvalStatus = query.approvalStatus;

    if (query.startDate || query.endDate) {
        filter.startDate = {};
        if (query.startDate) filter.startDate.$gte = new Date(String(query.startDate));
        if (query.endDate) filter.startDate.$lte = new Date(String(query.endDate));
    }

    if (query.search || query.plantId) {
        const assetFilter: Record<string, any> = { isDeleted: { $ne: true } };
        if (query.plantId) assetFilter.plantId = query.plantId;
        if (query.search) {
            const regex = new RegExp(String(query.search), 'i');
            assetFilter.$or = [{ name: regex }, { machineCode: regex }, { serial: regex }];
        }

        const assetIds = await Asset.find(assetFilter).distinct('_id');
        filter.assetId = filter.assetId
            ? { $in: assetIds.filter((id) => String(id) === String(filter.assetId)) }
            : { $in: assetIds };
    }

    return filter;
};

export const getAllMaintenances = async (req: Request, res: Response, next: NextFunction) => {
    await syncMaintenanceStatuses();
    const filter = await buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [items, total] = await Promise.all([
        applyPopulate(Maintenance.find(filter), WORKFLOW_POPULATE.maintenance)
            .sort('-createdAt')
            .skip(skip)
            .limit(limit),
        Maintenance.countDocuments(filter),
    ]);

    return sendSerializedPage(res, items, total, page, limit, serializeMaintenance, 'Lay danh sach bao tri thanh cong');
};

export const getMaintenanceByAsset = async (req: Request, res: Response, next: NextFunction) => {
    await syncMaintenanceStatuses();
    const items = await applyPopulate(
        Maintenance.find({ assetId: req.params.assetId, isDeleted: { $ne: true } }),
        WORKFLOW_POPULATE.maintenance
    ).sort('-createdAt');

    return sendSerializedList(res, items, serializeMaintenance, 'Lay lich su bao tri thanh cong');
};

export const getMaintenanceById = async (req: Request, res: Response, next: NextFunction) => {
    await syncMaintenanceStatuses();
    const item = await findOnePopulatedOrThrow({
        model: Maintenance,
        filter: { _id: req.params.id, isDeleted: { $ne: true } },
        populate: WORKFLOW_POPULATE.maintenance,
        notFoundMessage: 'Khong tim thay phieu bao tri',
    });

    return sendSerializedItem(res, item, serializeMaintenance, 'Lay chi tiet bao tri thanh cong');
};

export const createMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await Asset.findOne({ _id: req.body.assetId, isDeleted: { $ne: true } }).populate('plantId');
    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');
    if (asset.status === ASSET_STATUS.RETURNED_TO_PARTNER) {
        throw new BadRequestError('Thiet bi da tra doi tac, khong the tao phieu bao tri moi');
    }

    const approvedTransfer = await Transfer.findOne({
        $or: [{ assetId: req.body.assetId }, { assetIds: req.body.assetId }],
        status: 'approved',
        isDeleted: { $ne: true },
    });
    if (approvedTransfer) {
        throw new BadRequestError('Thiet bi dang trong qua trinh dieu chuyen, khong the tao phieu bao tri');
    }

    const repairMode = req.body.repairMode ?? 'internal';
    const isExternalRepair = repairMode === EXTERNAL_REPAIR_MODE;
    const status = isExternalRepair ? 'pending' : req.body.endDate ? 'completed' : 'in_progress';
    const approvalStatus = isExternalRepair ? 'pending' : 'none';
    const externalCost = isExternalRepair ? calculateExternalCost(req.body) : req.body.cost;

    // Snapshot cơ sở tại thời điểm tạo — không được thay đổi khi máy điều chuyển sau này
    const assetPlant = (asset as any).plantId;
    const plantIdSnapshot =
        assetPlant?._id ?? (asset.plantId && typeof asset.plantId !== 'object' ? asset.plantId : undefined);
    const plantNameSnapshot: string | undefined = assetPlant?.name;

    const item = await Maintenance.create({
        ...req.body,
        repairMode,
        approvalStatus,
        createdBy: req.userId,
        status,
        cost: externalCost ?? req.body.cost,
        plantId: plantIdSnapshot ?? undefined,
        plantName: plantNameSnapshot ?? undefined,
        areaAtCreation: asset.area ?? undefined,
        plantSnapshotSource: 'created_from_asset',
        plantIdBackfilled: false,
        externalRepair: isExternalRepair
            ? {
                  ...req.body.externalRepair,
                  actualCost: req.body.externalRepair?.actualCost ?? externalCost,
              }
            : req.body.externalRepair,
    });

    let updatedAsset: unknown;
    if (!isExternalRepair && status === 'in_progress') {
        updatedAsset = await Asset.findByIdAndUpdate(
            req.body.assetId,
            {
                status: ASSET_STATUS.MAINTENANCE,
            },
            { new: true }
        )
            .populate('brandId')
            .populate('plantId');
    }

    if (!isExternalRepair && status === 'completed') {
        updatedAsset = await Asset.findByIdAndUpdate(
            req.body.assetId,
            {
                status: getNextAssetStatus(asset),
                lastMaintenanceDate: req.body.endDate,
            },
            { new: true }
        )
            .populate('brandId')
            .populate('plantId');
    }

    const createdItem = await findOnePopulatedOrThrow({
        model: Maintenance,
        filter: { _id: item._id },
        populate: WORKFLOW_POPULATE.maintenance,
        notFoundMessage: 'Khong tim thay phieu bao tri',
    });

    // Send notification to admins about new maintenance
    const assetName = (createdItem.assetId as any)?.name || 'Thiết bị';
    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'info',
            actionType: 'maintenance',
            actionId: String(createdItem._id),
            title: 'Bảo trì mới',
            message: `${actorName} đã tạo phiếu bảo trì mới cho ${assetName}`,
        },
        { excludeUserIds: [req.userId] }
    );
    void appendMaintenanceSystemMessage(
        String(createdItem._id),
        `${actorName} đã tạo phiếu bảo trì cho ${assetName}.`,
        req.userId
    );

    if (updatedAsset) {
        broadcastAssetChange(updatedAsset, 'maintenance-created', ['status', 'lastMaintenanceDate']);
    }

    return sendSerializedItem(
        res,
        createdItem,
        serializeMaintenance,
        'Tao phieu bao tri thanh cong',
        StatusCodes.CREATED
    );
};

export const updateMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const updatePayload = { ...req.body };
    // Bảo vệ snapshot cơ sở — không cho phép client ghi đè
    delete updatePayload.plantId;
    delete updatePayload.plantName;
    delete updatePayload.areaAtCreation;
    delete updatePayload.plantSnapshotSource;
    delete updatePayload.plantIdBackfilled;

    if (updatePayload.repairMode === EXTERNAL_REPAIR_MODE || updatePayload.externalRepair) {
        const externalCost = calculateExternalCost(updatePayload);
        updatePayload.cost = externalCost;
        updatePayload.externalRepair = {
            ...updatePayload.externalRepair,
            actualCost: updatePayload.externalRepair?.actualCost ?? externalCost,
        };
    }

    // Load existing để kiểm tra snapshot — không cho phép findOneAndUpdate inline
    // vì cần dữ liệu record trước khi quyết định có backfill hay không
    const existing = await Maintenance.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!existing) throw new NotFoundError('Khong tim thay phieu bao tri');

    // Nếu record cũ thiếu plantId, backfill ngay lần update này
    if (!(existing as any).plantId) {
        const snapshot = await resolveMaintenancePlantSnapshot(existing);
        if (snapshot) Object.assign(updatePayload, snapshot);
    }

    const item = await applyPopulate(
        Maintenance.findOneAndUpdate({ _id: req.params.id, isDeleted: { $ne: true } }, updatePayload, {
            new: true,
            runValidators: true,
        }),
        WORKFLOW_POPULATE.maintenance
    );

    if (!item) throw new NotFoundError('Khong tim thay phieu bao tri');

    return sendSerializedItem(res, item, serializeMaintenance, 'Cap nhat bao tri thanh cong');
};

export const deleteMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const item = await Maintenance.findOneAndUpdate(
        { _id: req.params.id, isDeleted: { $ne: true } },
        { isDeleted: true, deletedAt: new Date() },
        { new: true }
    );

    if (!item) throw new NotFoundError('Khong tim thay phieu bao tri');

    return sendSuccess(res, null, 'Xoa phieu bao tri thanh cong');
};

export const completeMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const current = await findMaintenanceForAction(String(req.params.id));
    if (current.status === 'cancelled') {
        throw new BadRequestError('Phieu bao tri da bi huy hoac tu choi');
    }
    if (current.repairMode === EXTERNAL_REPAIR_MODE && current.approvalStatus !== 'approved') {
        throw new BadRequestError('Phieu sua ngoai can duoc duyet truoc khi hoan tat');
    }

    const externalCost = current.repairMode === EXTERNAL_REPAIR_MODE ? calculateExternalCost(req.body) : req.body.cost;
    const externalRepair =
        current.repairMode === EXTERNAL_REPAIR_MODE
            ? {
                  ...((current as any).externalRepair?.toObject?.() ?? (current as any).externalRepair ?? {}),
                  ...req.body.externalRepair,
                  returnedAt: req.body.externalRepair?.returnedAt ?? req.body.endDate,
                  actualCost: req.body.externalRepair?.actualCost ?? externalCost,
              }
            : (current as any).externalRepair;

    const item = await applyPopulate(
        Maintenance.findOneAndUpdate(
            { _id: req.params.id, isDeleted: { $ne: true } },
            {
                status: 'completed',
                endDate: req.body.endDate,
                note: req.body.note,
                cost: externalCost,
                externalRepair,
            },
            { new: true, runValidators: true }
        ),
        WORKFLOW_POPULATE.maintenance
    );

    if (!item) throw new NotFoundError('Khong tim thay phieu bao tri');

    const asset = await Asset.findById(item.assetId);
    const updatedAsset = await Asset.findByIdAndUpdate(
        item.assetId,
        {
            status: getNextAssetStatus(asset),
            lastMaintenanceDate: req.body.endDate,
        },
        { new: true }
    )
        .populate('brandId')
        .populate('plantId');

    // Send notification about completed maintenance
    const assetName = (item.assetId as any)?.name || 'Thiết bị';
    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'success',
            actionType: 'maintenance',
            actionId: String(item._id),
            title: 'Bảo trì hoàn tất',
            message: `${actorName} đã hoàn tất bảo trì ${assetName}`,
        },
        { excludeUserIds: [req.userId] }
    );
    void appendMaintenanceSystemMessage(
        String(item._id),
        `${actorName} đã hoàn tất bảo trì ${assetName}.`,
        req.userId
    );

    broadcastAssetChange(updatedAsset, 'maintenance-completed', ['status', 'lastMaintenanceDate']);

    return sendSerializedItem(res, item, serializeMaintenance, 'Hoan thanh bao tri thanh cong');
};

export const approveMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const item = await findMaintenanceForAction(String(req.params.id));

    if (item.repairMode !== EXTERNAL_REPAIR_MODE) {
        throw new BadRequestError('Chi phieu sua ngoai moi can duyet');
    }
    if (item.approvalStatus !== 'pending') {
        throw new BadRequestError('Phieu sua ngoai khong o trang thai cho duyet');
    }

    item.approvalStatus = 'approved';
    item.status = 'in_progress';
    item.note = req.body.note ?? item.note;
    (item as any).externalRepair = {
        ...((item as any).externalRepair?.toObject?.() ?? (item as any).externalRepair ?? {}),
        approvedBy: req.userId,
        approvedAt: new Date(),
    };
    await item.save();

    const updatedAsset = await Asset.findByIdAndUpdate(
        item.assetId,
        {
            status: ASSET_STATUS.MAINTENANCE,
        },
        { new: true }
    )
        .populate('brandId')
        .populate('plantId');

    const populated = await fetchPopulatedMaintenance(String(item._id));
    const actorName = await getActorName(req.userId);
    const assetName = ((populated as any).assetId as any)?.name || 'Thiết bị';
    void appendMaintenanceSystemMessage(
        String(item._id),
        `${actorName} đã duyệt phiếu sửa ngoài cho ${assetName}.`,
        req.userId
    );
    broadcastAssetChange(updatedAsset, 'maintenance-approved', ['status']);
    return sendSerializedItem(res, populated, serializeMaintenance, 'Da duyet phieu sua ngoai');
};

export const rejectMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const item = await findMaintenanceForAction(String(req.params.id));

    if (item.repairMode !== EXTERNAL_REPAIR_MODE) {
        throw new BadRequestError('Chi phieu sua ngoai moi can tu choi');
    }
    if (item.approvalStatus !== 'pending') {
        throw new BadRequestError('Phieu sua ngoai khong o trang thai cho duyet');
    }

    item.approvalStatus = 'rejected';
    item.status = 'cancelled';
    (item as any).externalRepair = {
        ...((item as any).externalRepair?.toObject?.() ?? (item as any).externalRepair ?? {}),
        rejectedBy: req.userId,
        rejectedAt: new Date(),
        rejectReason: req.body.rejectReason,
    };
    await item.save();

    const populated = await fetchPopulatedMaintenance(String(item._id));
    const actorName = await getActorName(req.userId);
    const assetName = ((populated as any).assetId as any)?.name || 'Thiết bị';
    void appendMaintenanceSystemMessage(
        String(item._id),
        `${actorName} đã từ chối phiếu sửa ngoài cho ${assetName}. Lý do: ${req.body.rejectReason}`,
        req.userId
    );
    return sendSerializedItem(res, populated, serializeMaintenance, 'Da tu choi phieu sua ngoai');
};

export const getMaintenanceReport = async (req: Request, res: Response, next: NextFunction) => {
    const startDate = parseReportDateStart(req.query.startDate);
    const endDate = parseReportDateEnd(req.query.endDate);
    const groupBy = ['day', 'month', 'quarter'].includes(String(req.query.groupBy))
        ? String(req.query.groupBy)
        : 'month';

    const completedMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        repairMode: EXTERNAL_REPAIR_MODE,
        status: 'completed',
    };

    if (startDate || endDate) {
        completedMatch.endDate = {};
        if (startDate) completedMatch.endDate.$gte = startDate;
        if (endDate) completedMatch.endDate.$lte = endDate;
    }

    const [completedItems, pendingApprovalCount, inProgressCount] = await Promise.all([
        Maintenance.find(completedMatch)
            .populate({ path: 'assetId', populate: ['brandId'] })
            .populate({ path: 'plantId' }),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            repairMode: EXTERNAL_REPAIR_MODE,
            approvalStatus: 'pending',
        }),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            repairMode: EXTERNAL_REPAIR_MODE,
            status: 'in_progress',
        }),
    ]);

    const totalExternalRepairCost = completedItems.reduce((sum: number, item: any) => sum + Number(item.cost ?? 0), 0);
    const costByPeriod = new Map<string, number>();
    const costByPlant = new Map<string, { plantId?: string; plantName: string; totalCost: number; count: number }>();
    const costByAsset = new Map<
        string,
        {
            assetId: string;
            assetName: string;
            machineCode?: string;
            plantName?: string;
            totalCost: number;
            count: number;
        }
    >();

    completedItems.forEach((item: any) => {
        const cost = Number(item.cost ?? 0);
        const endDateValue = item.endDate ? new Date(item.endDate) : new Date(item.updatedAt);
        const period = getPeriodLabel(endDateValue, groupBy);
        costByPeriod.set(period, Number(((costByPeriod.get(period) ?? 0) + cost).toFixed(2)));

        const asset = item.assetId;
        // Dùng snapshot cơ sở từ maintenance record (đúng nghiệp vụ)
        // Bản ghi cũ chưa backfill hiển thị là 'unknown' — chạy backfill để khắc phục
        const maintenancePlantId: string | undefined = (item as any).plantId?._id
            ? String((item as any).plantId._id)
            : (item as any).plantId
              ? String((item as any).plantId)
              : undefined;
        const maintenancePlantName: string | undefined = (item as any).plantName || (item as any).plantId?.name;
        const plantId = maintenancePlantId ?? 'unknown';
        const plantName = maintenancePlantName ?? 'Chưa xác định';
        const plantRow = costByPlant.get(plantId) ?? { plantId, plantName, totalCost: 0, count: 0 };
        plantRow.totalCost = Number((plantRow.totalCost + cost).toFixed(2));
        plantRow.count += 1;
        costByPlant.set(plantId, plantRow);

        if (asset?._id) {
            const assetId = String(asset._id);
            const assetRow = costByAsset.get(assetId) ?? {
                assetId,
                assetName: asset.name,
                machineCode: asset.machineCode,
                plantName,
                totalCost: 0,
                count: 0,
            };
            assetRow.totalCost = Number((assetRow.totalCost + cost).toFixed(2));
            assetRow.count += 1;
            costByAsset.set(assetId, assetRow);
        }
    });

    return sendSuccess(
        res,
        {
            summary: {
                totalExternalRepairCost: Number(totalExternalRepairCost.toFixed(2)),
                externalRepairCount: completedItems.length,
                pendingApprovalCount,
                inProgressCount,
            },
            costByPeriod: Array.from(costByPeriod.entries())
                .map(([period, totalCost]) => ({ period, totalCost }))
                .sort((a, b) => a.period.localeCompare(b.period)),
            costByPlant: Array.from(costByPlant.values()).sort((a, b) => b.totalCost - a.totalCost),
            topAssets: Array.from(costByAsset.values())
                .sort((a, b) => b.totalCost - a.totalCost)
                .slice(0, 10),
        },
        'Lay bao cao bao tri thanh cong'
    );
};
