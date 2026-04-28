import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import { transferRepository } from '@/repositories/transfer.repository';
import { getPagination } from '@/utils/pagination';
import { serializeTransfer } from '@/utils/serializers';
import { sendSerializedItem, sendSerializedList, sendSerializedPage } from './service.helpers';
import { notifyAdmins } from './notification.helper';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildFilter = async (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (query.assetId) filter.assetId = query.assetId;
    if (query.fromPlantId) filter.fromPlantId = query.fromPlantId;
    if (query.toPlantId) filter.toPlantId = query.toPlantId;
    if (query.status) filter.status = query.status;

    if (query.search) {
        const regex = new RegExp(String(query.search), 'i');
        const assetIds = await Asset.find({
            isDeleted: { $ne: true },
            $or: [{ name: regex }, { machineCode: regex }, { serial: regex }],
        }).distinct('_id');

        filter.$or = [
            { reason: regex },
            { note: regex },
            { fromArea: regex },
            { toArea: regex },
            { assetId: { $in: assetIds } },
        ];
    }

    return filter;
};

const getParamValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);
const trimLocation = (value?: string | null) => value?.trim() || undefined;
const toDocumentId = (value: unknown) =>
    value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)
        ? String((value as Record<string, unknown>)._id)
        : String(value);

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

export const createTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await Asset.findOne({ _id: req.body.assetId, isDeleted: { $ne: true } });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    const existingOpenTransfer = await transferRepository.findOpenByAssetId(req.body.assetId);

    if (existingOpenTransfer) {
        throw new DuplicateError('Thiet bi dang co lenh dieu chuyen chua hoan tat');
    }

    const fromArea = trimLocation(asset.area);
    const toArea = trimLocation(req.body.toArea);
    const isSamePlant = String(asset.plantId) === String(req.body.toPlantId);
    const isSameArea = fromArea === toArea;

    if (isSamePlant && isSameArea) {
        throw new BadRequestError('Vi tri dieu chuyen moi phai khac vi tri hien tai cua thiet bi');
    }

    const item = await transferRepository.create({
        ...req.body,
        fromPlantId: asset.plantId,
        fromArea,
        toArea,
        createdBy: req.userId,
    });

    const createdItem = await transferRepository.findById(String(item._id));

    if (!createdItem) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    // Send notification to admins about new transfer request
    const assetName = (createdItem.assetId as any)?.name || 'Thiết bị';
    await notifyAdmins('notify:new', {
        _id: `transfer-${createdItem._id}`,
        userId: '',
        type: 'warning',
        actionType: 'transfer',
        actionId: String(createdItem._id),
        title: 'Yêu cầu điều chuyển mới',
        message: `${assetName} cần được điều chuyển từ ${createdItem.fromArea} đến ${createdItem.toArea}`,
        isRead: false,
        createdAt: new Date().toISOString(),
    });

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
    const assetName = (item.assetId as any)?.name || 'Thiết bị';
    await notifyAdmins('notify:new', {
        _id: `transfer-approved-${item._id}`,
        userId: '',
        type: 'success',
        actionType: 'transfer',
        actionId: String(item._id),
        title: 'Điều chuyển đã được duyệt',
        message: `${assetName} đã được duyệt điều chuyển`,
        isRead: false,
        createdAt: new Date().toISOString(),
    });

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

    // Send notification about rejected transfer
    const assetName = (item.assetId as any)?.name || 'Thiết bị';
    await notifyAdmins('notify:new', {
        _id: `transfer-rejected-${item._id}`,
        userId: '',
        type: 'error',
        actionType: 'transfer',
        actionId: String(item._id),
        title: 'Điều chuyển bị từ chối',
        message: `${assetName} đã bị từ chối điều chuyển: ${item.rejectReason || 'Không có lý do'}`,
        isRead: false,
        createdAt: new Date().toISOString(),
    });

    return sendSerializedItem(res, item, serializeTransfer, 'Tu choi dieu chuyen thanh cong');
};

export const completeTransfer = async (req: Request, res: Response, next: NextFunction) => {
    const transferId = getParamValue(req.params.id);
    const currentTransfer = await transferRepository.findById(transferId);

    if (!currentTransfer) throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    if (currentTransfer.status !== 'approved') {
        throw new BadRequestError('Chi co the hoan thanh lenh dieu chuyen da duoc duyet');
    }

    const currentAssetStatus =
        currentTransfer.assetId && typeof currentTransfer.assetId === 'object' && 'status' in currentTransfer.assetId
            ? String(currentTransfer.assetId.status)
            : ASSET_STATUS.ACTIVE;

    const item = await transferRepository.updateById(transferId, {
        status: 'completed',
        completedBy: req.userId,
        completedAt: new Date(),
    });

    if (!item) throw new NotFoundError('Khong tim thay lenh dieu chuyen');

    await Asset.findByIdAndUpdate(toDocumentId(item.assetId), {
        plantId: toDocumentId(item.toPlantId),
        area: item.toArea ?? null,
        status: currentAssetStatus,
        updatedBy: req.userId,
    });

    // Send notification about completed transfer
    const assetName = (item.assetId as any)?.name || 'Thiết bị';
    await notifyAdmins('notify:new', {
        _id: `transfer-completed-${item._id}`,
        userId: '',
        type: 'success',
        actionType: 'transfer',
        actionId: String(item._id),
        title: 'Điều chuyển hoàn tất',
        message: `${assetName} đã hoàn tất điều chuyển đến ${item.toArea}`,
        isRead: false,
        createdAt: new Date().toISOString(),
    });

    return sendSerializedItem(res, item, serializeTransfer, 'Hoan thanh dieu chuyen thanh cong');
};
