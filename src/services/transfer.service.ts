import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import TransferHistory from '@/models/TransferHistory';
import User from '@/models/User';
import { transferRepository } from '@/repositories/transfer.repository';
import { getPagination } from '@/utils/pagination';
import { serializeTransfer } from '@/utils/serializers';
import { sendSerializedItem, sendSerializedList, sendSerializedPage } from './service.helpers';
import { notifyAdmins, notifyUser, getActorName } from './notification.helper';
import { appendWorkflowSystemMessage } from './chat.service';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildFilter = async (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const andConditions: Record<string, any>[] = [];

    if (query.assetId) andConditions.push({ $or: [{ assetId: query.assetId }, { assetIds: query.assetId }] });
    if (query.fromPlantId) filter.fromPlantId = query.fromPlantId;
    if (query.toPlantId) filter.toPlantId = query.toPlantId;
    if (query.status) filter.status = query.status;

    if (query.search) {
        const regex = new RegExp(String(query.search), 'i');
        const assetIds = await Asset.find({
            isDeleted: { $ne: true },
            $or: [{ name: regex }, { machineCode: regex }, { serial: regex }],
        }).distinct('_id');

        andConditions.push({
            $or: [
                { reason: regex },
                { note: regex },
                { fromArea: regex },
                { toArea: regex },
                { assetId: { $in: assetIds } },
                { assetIds: { $in: assetIds } },
            ],
        });
    }

    if (andConditions.length) {
        filter.$and = andConditions;
    }

    return filter;
};

const getParamValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);
const trimLocation = (value?: string | null) => value?.trim() || undefined;
const toDocumentId = (value: unknown) =>
    value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)
        ? String((value as Record<string, unknown>)._id)
        : String(value);
const sameId = (left: unknown, right: unknown) => String(left) === String(right);

const getTransferAssets = (transfer: any) => {
    const populatedAssets = Array.isArray(transfer?.assetIds)
        ? transfer.assetIds.filter((asset: any) => asset && typeof asset === 'object' && asset._id)
        : [];

    if (populatedAssets.length) return populatedAssets;
    return transfer?.assetId && typeof transfer.assetId === 'object' ? [transfer.assetId] : [];
};

const getTransferAssetIds = (transfer: any): string[] => {
    const populatedAssetIds = getTransferAssets(transfer).map((asset: any) => toDocumentId(asset));
    if (populatedAssetIds.length) return populatedAssetIds;

    return [toDocumentId(transfer.assetId)].filter((assetId): assetId is string =>
        Boolean(assetId && assetId !== 'undefined')
    );
};

const formatAssetLabel = (assets: any[]) => {
    if (assets.length === 1) return assets[0]?.name || 'Thiet bi';
    return `${assets.length} thiet bi`;
};

export const getAllTransfers = async (req: Request, res: Response, next: NextFunction) => {
    const filter = await buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [items, total] = await Promise.all([
        transferRepository.findMany(filter, { sort: '-createdAt', skip, limit }),
        transferRepository.countDocuments(filter),
    ]);

    return sendSerializedPage(
        res,
        items,
        total,
        page,
        limit,
        serializeTransfer,
        'Lay danh sach dieu chuyen thanh cong'
    );
};

export const getTransferByAsset = async (req: Request, res: Response, next: NextFunction) => {
    const assetId = getParamValue(req.params.assetId);
    const items = await transferRepository.findByAssetId(assetId);

    return sendSerializedList(res, items, serializeTransfer, 'Lay lich su dieu chuyen thanh cong');
};

export const getTransferById = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const item = await transferRepository.findById(transferId);

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    return sendSerializedItem(res, item, serializeTransfer, 'Lay chi tiet dieu chuyen thanh cong');
};

const getUserDisplayName = (user: any) => user?.fullname || user?.username || user?.email || '';

const buildTransferUserNames = async (transfer: any) => {
    const ids = [
        toDocumentId(transfer.createdBy),
        toDocumentId(transfer.approvedBy),
        toDocumentId(transfer.completedBy),
        toDocumentId(transfer.cancelledBy),
    ].filter((id) => id && id !== 'undefined');

    if (!ids.length) return {};

    const users = await User.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
        .select('fullname username email')
        .lean();
    const byId = new Map(users.map((user: any) => [String(user._id), getUserDisplayName(user)]));

    return {
        createdByName: byId.get(toDocumentId(transfer.createdBy)) || '',
        approvedByName: byId.get(toDocumentId(transfer.approvedBy)) || '',
        completedByName: byId.get(toDocumentId(transfer.completedBy)) || '',
        cancelledByName: byId.get(toDocumentId(transfer.cancelledBy)) || '',
    };
};

export const exportTransferStockOutXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const item = await transferRepository.findById(transferId);

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    if (!['approved', 'completed'].includes(String((item as any).status))) {
        throw new BadRequestError('Chi co the xuat phieu xuat kho cho lenh da duoc duyet hoac da hoan tat');
    }

    const plain = {
        ...serializeTransfer(item),
        ...(await buildTransferUserNames(item)),
    };

    if (!Array.isArray(plain.assets) || plain.assets.length === 0) {
        throw new BadRequestError('Lenh dieu chuyen khong co danh sach may de xuat kho');
    }

    const { generateTransferStockOutXlsx } = await import('@/utils/generateTransferStockOutXlsx');
    const buffer = await generateTransferStockOutXlsx(plain);
    const filename = `phieu-xuat-kho-dieu-chuyen-${String(plain.id).slice(-6)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(StatusCodes.OK).send(buffer);
};

export const createTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const requestedAssetIds = Array.from(
        new Set([...(req.body.assetIds ?? []), req.body.assetId].filter(Boolean).map(String))
    );

    if (!requestedAssetIds.length) {
        throw new BadRequestError('Vui long chon thiet bi');
    }

    const assets = await Asset.find({ _id: { $in: requestedAssetIds }, isDeleted: { $ne: true } });

    if (assets.length !== requestedAssetIds.length) {
        throw new NotFoundError('Mot so thiet bi khong ton tai');
    }

    const returnedPartnerAssets = assets.filter((asset) => asset.status === ASSET_STATUS.RETURNED_TO_PARTNER);
    if (returnedPartnerAssets.length) {
        throw new BadRequestError(
            `Khong the dieu chuyen may da tra doi tac: ${returnedPartnerAssets.map((asset) => asset.name).join(', ')}`
        );
    }

    const existingOpenTransfers = await transferRepository.findOpenByAssetIds(requestedAssetIds);

    if (existingOpenTransfers.length) {
        const blockedAssetIds = new Set(
            existingOpenTransfers.flatMap((transfer: any) => getTransferAssetIds(transfer))
        );
        const blockedNames = assets
            .filter((asset) => blockedAssetIds.has(String(asset._id)))
            .map((asset) => asset.name)
            .join(', ');

        throw new DuplicateError(
            blockedNames
                ? `Thiet bi dang co lenh dieu chuyen chua hoan tat: ${blockedNames}`
                : 'Thiet bi dang co lenh dieu chuyen chua hoan tat'
        );
    }

    const [firstAsset] = assets;
    const hasDifferentSource = assets.some(
        (asset) =>
            !sameId(asset.plantId, firstAsset.plantId) || trimLocation(asset.area) !== trimLocation(firstAsset.area)
    );

    if (hasDifferentSource) {
        throw new BadRequestError('Chi co the tao mot lenh cho cac thiet bi cung co so va cung khu vuc hien tai');
    }

    const fromArea = trimLocation(firstAsset.area);
    const toArea = trimLocation(req.body.toArea);
    const isSamePlant = String(firstAsset.plantId) === String(req.body.toPlantId);
    const isSameArea = fromArea === toArea;

    if (isSamePlant && isSameArea) {
        throw new BadRequestError('Vi tri dieu chuyen moi phai khac vi tri hien tai cua thiet bi');
    }

    const item = await transferRepository.create({
        ...req.body,
        assetId: firstAsset._id,
        assetIds: assets.map((asset) => asset._id),
        fromPlantId: firstAsset.plantId,
        fromArea,
        toArea,
        createdBy: req.userId,
    });

    const createdItem = await transferRepository.findById(String(item._id));

    if (!createdItem) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    // Send notification to admins about new transfer request
    const assetName = formatAssetLabel(getTransferAssets(createdItem));
    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'warning',
            actionType: 'transfer',
            actionId: String(createdItem._id),
            title: 'Yêu cầu điều chuyển mới',
            message: `${actorName} đã tạo yêu cầu điều chuyển ${assetName} từ ${createdItem.fromArea} đến ${createdItem.toArea}`,
        },
        { excludeUserIds: [req.userId] }
    );

    void appendWorkflowSystemMessage(
        'transfer',
        String(createdItem._id),
        `${actorName} đã tạo lệnh điều chuyển ${assetName} từ ${createdItem.fromArea} đến ${createdItem.toArea}.`,
        req.userId
    );

    return sendSerializedItem(
        res,
        createdItem,
        serializeTransfer,
        'Tao lenh dieu chuyen thanh cong',
        StatusCodes.CREATED
    );
};

export const approveTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const currentTransfer = await transferRepository.findById(transferId);

    if (!currentTransfer) throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    if (currentTransfer.status !== 'pending') {
        throw new BadRequestError('Chi co the duyet lenh dieu chuyen dang cho xu ly');
    }

    const item = await transferRepository.updateById(transferId, {
        status: 'approved',
        approvedBy: req.userId,
        approvedAt: new Date(),
        rejectReason: null,
    });

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    // Send notification about approved transfer
    const assetName = formatAssetLabel(getTransferAssets(item));
    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'success',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Điều chuyển đã được duyệt',
            message: `${actorName} đã duyệt điều chuyển ${assetName}`,
        },
        { excludeUserIds: [req.userId, String((item as any).createdBy)] }
    );

    // Notify người tạo lệnh
    const createdById = String((item as any).createdBy);
    if (createdById && createdById !== req.userId) {
        await notifyUser(createdById, 'notify:new', {
            type: 'success',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Lệnh điều chuyển đã được duyệt',
            message: `${actorName} đã duyệt lệnh điều chuyển ${assetName}`,
            isRead: false,
            createdAt: new Date().toISOString(),
        });
    }

    void appendWorkflowSystemMessage(
        'transfer',
        String(item._id),
        `${actorName} đã duyệt lệnh điều chuyển ${assetName}.`,
        req.userId
    );

    return sendSerializedItem(res, item, serializeTransfer, 'Duyet dieu chuyen thanh cong');
};

export const rejectTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const currentTransfer = await transferRepository.findById(transferId);

    if (!currentTransfer) throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    if (currentTransfer.status !== 'pending') {
        throw new BadRequestError('Chi co the tu choi lenh dieu chuyen dang cho xu ly');
    }

    const item = await transferRepository.updateById(transferId, {
        status: 'rejected',
        rejectReason: req.body.reason,
        approvedBy: req.userId,
        approvedAt: new Date(),
    });

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    const assetName = formatAssetLabel(getTransferAssets(item));
    const actorName = await getActorName(req.userId);

    await notifyAdmins(
        'notify:new',
        {
            type: 'error',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Điều chuyển bị từ chối',
            message: `${actorName} đã từ chối điều chuyển ${assetName}: ${item.rejectReason || 'Không có lý do'}`,
        },
        { excludeUserIds: [req.userId, String((item as any).createdBy)] }
    );

    // Notify người tạo lệnh
    const createdById = String((item as any).createdBy);
    if (createdById && createdById !== req.userId) {
        await notifyUser(createdById, 'notify:new', {
            type: 'error',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Lệnh điều chuyển bị từ chối',
            message: `${actorName} đã từ chối lệnh điều chuyển ${assetName}: ${item.rejectReason || 'Không có lý do'}`,
            isRead: false,
            createdAt: new Date().toISOString(),
        });
    }

    void appendWorkflowSystemMessage(
        'transfer',
        String(item._id),
        `${actorName} đã từ chối lệnh điều chuyển ${assetName}. Lý do: ${item.rejectReason || 'Không có lý do'}`,
        req.userId
    );

    return sendSerializedItem(res, item, serializeTransfer, 'Tu choi dieu chuyen thanh cong');
};

export const completeTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const currentTransfer = await transferRepository.findById(transferId);

    if (!currentTransfer) throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    if (currentTransfer.status !== 'approved') {
        throw new BadRequestError('Chi co the hoan thanh lenh dieu chuyen da duoc duyet');
    }

    const currentAssets = getTransferAssets(currentTransfer);

    const item = await transferRepository.updateById(transferId, {
        status: 'completed',
        completedBy: req.userId,
        completedAt: new Date(),
        receivedBy: req.body.receivedBy?.trim() || undefined,
        handoverImages: req.body.handoverImages || [],
    });

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    const itemAssetIds = getTransferAssetIds(item);
    const statusByAssetId = new Map(
        currentAssets.map((asset: any) => [toDocumentId(asset), String(asset.status || ASSET_STATUS.ACTIVE)])
    );

    await Promise.all(
        itemAssetIds.map((assetId) =>
            Asset.findByIdAndUpdate(assetId, {
                plantId: toDocumentId(item.toPlantId),
                area: item.toArea ?? null,
                status: statusByAssetId.get(assetId) || ASSET_STATUS.ACTIVE,
                updatedBy: req.userId,
            })
        )
    );

    // Ghi TransferHistory
    const fromPlantName = (item.fromPlantId as any)?.name || String(item.fromPlantId);
    const toPlantName = (item.toPlantId as any)?.name || String(item.toPlantId);
    await TransferHistory.insertMany(
        itemAssetIds.map((assetId) => ({
            machineId: assetId,
            fromPlantId: toDocumentId(item.fromPlantId),
            fromPlant: fromPlantName,
            toPlantId: toDocumentId(item.toPlantId),
            toPlant: toPlantName,
            note: item.note || undefined,
            createdBy: req.userId,
        }))
    );

    const assetName = formatAssetLabel(getTransferAssets(item));
    const actorName = await getActorName(req.userId);

    await notifyAdmins(
        'notify:new',
        {
            type: 'success',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Điều chuyển hoàn tất',
            message: `${actorName} đã hoàn tất điều chuyển ${assetName} đến ${item.toArea || toPlantName}`,
        },
        { excludeUserIds: [req.userId, String((item as any).createdBy)] }
    );

    // Notify người tạo lệnh
    const createdById = String((item as any).createdBy);
    if (createdById && createdById !== req.userId) {
        await notifyUser(createdById, 'notify:new', {
            type: 'success',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Lệnh điều chuyển hoàn tất',
            message: `${assetName} đã được điều chuyển thành công đến ${item.toArea || toPlantName}`,
            isRead: false,
            createdAt: new Date().toISOString(),
        });
    }

    void appendWorkflowSystemMessage(
        'transfer',
        String(item._id),
        `${actorName} đã hoàn tất điều chuyển ${assetName} đến ${item.toArea || toPlantName}.`,
        req.userId
    );

    return sendSerializedItem(res, item, serializeTransfer, 'Hoan thanh dieu chuyen thanh cong');
};

export const cancelTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const currentTransfer = await transferRepository.findById(transferId);

    if (!currentTransfer) throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    if (currentTransfer.status !== 'pending') {
        throw new BadRequestError('Chi co the huy lenh dieu chuyen dang cho xu ly');
    }

    // Chỉ người tạo hoặc admin/manager mới được hủy
    const createdById = String((currentTransfer as any).createdBy);
    const isCreator = createdById === req.userId;
    const isManager = ['admin', 'manager', 'director'].includes((req as any).userRole || '');
    if (!isCreator && !isManager) {
        throw new BadRequestError('Ban khong co quyen huy lenh dieu chuyen nay');
    }

    const item = await transferRepository.updateById(transferId, {
        status: 'cancelled',
        cancelledBy: req.userId,
        cancelledAt: new Date(),
        cancelReason: req.body.reason,
    });

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    const assetName = formatAssetLabel(getTransferAssets(item));
    const actorName = await getActorName(req.userId);

    await notifyAdmins(
        'notify:new',
        {
            type: 'warning',
            actionType: 'transfer',
            actionId: String(item._id),
            title: 'Lệnh điều chuyển bị hủy',
            message: `${actorName} đã hủy lệnh điều chuyển ${assetName}: ${req.body.reason}`,
        },
        { excludeUserIds: [req.userId, String((item as any).createdBy)] }
    );

    void appendWorkflowSystemMessage(
        'transfer',
        String(item._id),
        `${actorName} đã hủy lệnh điều chuyển ${assetName}. Lý do: ${req.body.reason}`,
        req.userId
    );

    return sendSerializedItem(res, item, serializeTransfer, 'Huy dieu chuyen thanh cong');
};
