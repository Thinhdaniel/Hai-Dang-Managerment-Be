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

// Danh sách máy của phiếu (gồm máy chính), fallback [assetId] cho phiếu cũ 1 máy
const getMaintenanceAssetIds = (m: any): string[] => {
    const list = Array.isArray(m?.assetIds) && m.assetIds.length ? m.assetIds : [m?.assetId];
    return Array.from(new Set(list.map((a: any) => String(a?._id ?? a)).filter(Boolean)));
};

// Đặt trạng thái + ngày bảo trì gần nhất cho mọi máy trong phiếu; trả về danh sách asset đã cập nhật
const applyStatusToMaintenanceAssets = async (
    assetIds: string[],
    mode: 'maintenance' | 'done',
    lastMaintenanceDate?: Date
) => {
    const updated: unknown[] = [];
    for (const id of assetIds) {
        const current = await Asset.findById(id);
        if (!current) continue;
        const patch =
            mode === 'maintenance'
                ? { status: ASSET_STATUS.MAINTENANCE }
                : { status: getNextAssetStatus(current), lastMaintenanceDate };
        const next = await Asset.findByIdAndUpdate(id, patch, { new: true }).populate('brandId').populate('plantId');
        if (next) updated.push(next);
    }
    return updated;
};

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
    let scopedAssetIds: any[] | undefined;

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

        scopedAssetIds = await Asset.find(assetFilter).distinct('_id');
    }

    if (query.assetId) {
        const selectedAssetId = String(query.assetId);
        scopedAssetIds = scopedAssetIds
            ? scopedAssetIds.filter((id) => String(id) === selectedAssetId)
            : [selectedAssetId];
    }

    if (scopedAssetIds) {
        if (!scopedAssetIds.length) {
            filter._id = { $exists: false };
        } else {
            filter.$or = [{ assetId: { $in: scopedAssetIds } }, { assetIds: { $in: scopedAssetIds } }];
        }
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
        Maintenance.find({
            isDeleted: { $ne: true },
            $or: [{ assetId: req.params.assetId }, { assetIds: req.params.assetId }],
        }),
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

export const exportMaintenanceXlsx = async (req: Request, res: Response, _next: NextFunction) => {
    const { generateMaintenanceXlsx } = await import('@/utils/generateMaintenanceXlsx');
    const item = await findOnePopulatedOrThrow({
        model: Maintenance,
        filter: { _id: req.params.id, isDeleted: { $ne: true } },
        populate: WORKFLOW_POPULATE.maintenance,
        notFoundMessage: 'Khong tim thay phieu bao tri',
    });

    const data = serializeMaintenance(item);
    const buffer = await generateMaintenanceXlsx(data);
    const prefix = data.repairMode === 'external' ? 'SuaNgoai' : 'BaoTri';
    const filename = `${prefix}-${String(data.id ?? req.params.id)
        .slice(-5)
        .toUpperCase()}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
};

export const createMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    // Gộp máy chính + danh sách máy → 1 phiếu có thể chứa nhiều máy
    const requestedIds: string[] = Array.from(
        new Set(
            [
                ...(Array.isArray(req.body.assetIds) ? req.body.assetIds : []),
                req.body.assetId,
            ]
                .map((id) => (id ? String(id) : ''))
                .filter(Boolean)
        )
    );
    if (!requestedIds.length) throw new BadRequestError('Chua chon thiet bi can bao tri');

    const assets = await Asset.find({ _id: { $in: requestedIds }, isDeleted: { $ne: true } }).populate('plantId');
    if (assets.length !== requestedIds.length) throw new NotFoundError('Khong tim thay mot so thiet bi');

    if (assets.some((a) => a.status === ASSET_STATUS.RETURNED_TO_PARTNER)) {
        throw new BadRequestError('Co thiet bi da tra doi tac, khong the tao phieu bao tri moi');
    }

    const approvedTransfer = await Transfer.findOne({
        $or: [{ assetId: { $in: requestedIds } }, { assetIds: { $in: requestedIds } }],
        status: 'approved',
        isDeleted: { $ne: true },
    });
    if (approvedTransfer) {
        throw new BadRequestError('Co thiet bi dang trong qua trinh dieu chuyen, khong the tao phieu bao tri');
    }

    // Máy chính = máy đầu tiên (giữ snapshot cơ sở + logic per-máy)
    const primaryId = req.body.assetId && requestedIds.includes(String(req.body.assetId)) ? String(req.body.assetId) : requestedIds[0];
    const asset = assets.find((a) => String(a._id) === primaryId) ?? assets[0];

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
        assetId: primaryId,
        assetIds: requestedIds,
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

    // Cập nhật trạng thái cho TẤT CẢ máy trong phiếu (không chỉ máy chính)
    const updatedAssets: unknown[] = [];
    if (!isExternalRepair && (status === 'in_progress' || status === 'completed')) {
        for (const a of assets) {
            const patch =
                status === 'in_progress'
                    ? { status: ASSET_STATUS.MAINTENANCE }
                    : { status: getNextAssetStatus(a), lastMaintenanceDate: req.body.endDate };
            const updated = await Asset.findByIdAndUpdate(a._id, patch, { new: true })
                .populate('brandId')
                .populate('plantId');
            if (updated) updatedAssets.push(updated);
        }
    }

    const createdItem = await findOnePopulatedOrThrow({
        model: Maintenance,
        filter: { _id: item._id },
        populate: WORKFLOW_POPULATE.maintenance,
        notFoundMessage: 'Khong tim thay phieu bao tri',
    });

    // Send notification to admins about new maintenance
    const createdAssets = Array.isArray((createdItem as any).assetIds) && (createdItem as any).assetIds.length
        ? (createdItem as any).assetIds
        : [(createdItem as any).assetId].filter(Boolean);
    const assetName =
        createdAssets.length > 1
            ? `${createdAssets.length} máy`
            : (createdItem.assetId as any)?.name || 'Thiết bị';
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

    updatedAssets.forEach((a) => broadcastAssetChange(a, 'maintenance-created', ['status', 'lastMaintenanceDate']));

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

    // Sửa danh sách máy: chuẩn hoá + giữ máy chính = máy đầu tiên
    if (Array.isArray(updatePayload.assetIds)) {
        const ids = Array.from(new Set(updatePayload.assetIds.map((id: any) => String(id)).filter(Boolean)));
        if (ids.length) {
            updatePayload.assetIds = ids;
            if (!ids.includes(String(updatePayload.assetId))) updatePayload.assetId = ids[0];
        } else {
            delete updatePayload.assetIds;
        }
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

    const updatedAssets = await applyStatusToMaintenanceAssets(
        getMaintenanceAssetIds(item),
        'done',
        req.body.endDate
    );

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
    void appendMaintenanceSystemMessage(String(item._id), `${actorName} đã hoàn tất bảo trì ${assetName}.`, req.userId);

    updatedAssets.forEach((a) => broadcastAssetChange(a, 'maintenance-completed', ['status', 'lastMaintenanceDate']));

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

    const updatedAssets = await applyStatusToMaintenanceAssets(getMaintenanceAssetIds(item), 'maintenance');

    const populated = await fetchPopulatedMaintenance(String(item._id));
    const actorName = await getActorName(req.userId);
    const assetName = ((populated as any).assetId as any)?.name || 'Thiết bị';
    void appendMaintenanceSystemMessage(
        String(item._id),
        `${actorName} đã duyệt phiếu sửa ngoài cho ${assetName}.`,
        req.userId
    );
    updatedAssets.forEach((a) => broadcastAssetChange(a, 'maintenance-approved', ['status']));
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
