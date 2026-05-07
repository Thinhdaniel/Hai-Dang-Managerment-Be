import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import Transfer from '@/models/Transfer';
import { borrowingRepository } from '@/repositories/borrowing.repository';
import { getPagination } from '@/utils/pagination';
import { serializeBorrowing } from '@/utils/serializers';
import { sendSerializedItem, sendSerializedList, sendSerializedPage } from './service.helpers';
import { notifyAdmins, getActorName } from './notification.helper';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const getParamValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

const trimText = (value?: string | null) => value?.trim() || undefined;

const toDocumentId = (value: unknown) =>
    value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)
        ? String((value as Record<string, unknown>)._id)
        : String(value);

const buildFilter = async (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (query.assetId) filter.assetId = query.assetId;
    if (query.borrowerId) filter.borrowerId = query.borrowerId;
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;

    if (query.startDate || query.endDate) {
        filter.borrowTime = {};
        if (query.startDate) filter.borrowTime.$gte = new Date(String(query.startDate));
        if (query.endDate) filter.borrowTime.$lte = new Date(String(query.endDate));
    }

    if (query.search) {
        const regex = new RegExp(String(query.search), 'i');
        const assetIds = await Asset.find({
            isDeleted: { $ne: true },
            $or: [{ name: regex }, { machineCode: regex }, { serial: regex }],
        }).distinct('_id');

        filter.$or = [
            { borrowerName: regex },
            { partnerName: regex },
            { purpose: regex },
            { location: regex },
            { note: regex },
            { assetId: { $in: assetIds } },
        ];
    }

    return filter;
};

export const getAllBorrowings = async (req: Request, res: Response, next: NextFunction) => {
    const filter = await buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [items, total] = await Promise.all([
        borrowingRepository.findMany(filter, { sort: '-borrowTime', skip, limit }),
        borrowingRepository.countDocuments(filter),
    ]);

    return sendSerializedPage(
        res,
        items,
        total,
        page,
        limit,
        serializeBorrowing,
        'Lay danh sach giao dich thiet bi thanh cong'
    );
};

export const getBorrowingByAsset = async (req: Request, res: Response, next: NextFunction) => {
    const assetId = getParamValue(req.params.assetId);
    const items = await borrowingRepository.findByAssetId(assetId);

    return sendSerializedList(res, items, serializeBorrowing, 'Lay lich su giao dich thiet bi thanh cong');
};

export const getBorrowingById = async (req: Request, res: Response, next: NextFunction) => {
    const borrowingId = getParamValue(req.params.id);
    const item = await borrowingRepository.findById(borrowingId);

    if (!item) throw new NotFoundError('Khong tim thay giao dich thiet bi');

    return sendSerializedItem(res, item, serializeBorrowing, 'Lay chi tiet giao dich thiet bi thanh cong');
};

export const createBorrowing = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await Asset.findOne({ _id: req.body.assetId, isDeleted: { $ne: true } });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    const activeTransaction = await borrowingRepository.findActiveByAssetId(req.body.assetId);

    if (activeTransaction) {
        throw new DuplicateError('Thiet bi dang co giao dich muon / thue chua hoan tat');
    }

    const approvedTransfer = await Transfer.findOne({
        assetId: req.body.assetId,
        status: 'approved',
        isDeleted: { $ne: true },
    });
    if (approvedTransfer) {
        throw new BadRequestError('Thiet bi dang trong qua trinh dieu chuyen, khong the tao giao dich');
    }

    const item = await borrowingRepository.create({
        assetId: req.body.assetId,
        type: req.body.type,
        borrowerId: undefined,
        borrowerName: req.body.type === 'internal' ? trimText(req.body.borrowerName) : undefined,
        partnerName: req.body.type === 'internal' ? undefined : trimText(req.body.partnerName),
        borrowTime: req.body.borrowTime,
        purpose: trimText(req.body.purpose),
        location: trimText(req.body.location),
        cost: req.body.type === 'rental' ? req.body.cost : undefined,
        note: trimText(req.body.note),
        assetStatusBefore: asset.status,
        createdBy: req.userId,
    });

    await Asset.findByIdAndUpdate(req.body.assetId, {
        status: ASSET_STATUS.BORROWING,
        updatedBy: req.userId,
    });

    const createdItem = await borrowingRepository.findById(String(item._id));

    if (!createdItem) throw new NotFoundError('Khong tim thay giao dich thiet bi');

    // Send notification to admins about new borrowing
    const assetName = (createdItem.assetId as any)?.name || 'Thiết bị';
    const actorName = await getActorName(req.userId);
    await notifyAdmins('notify:new', {
        _id: `borrowing-${createdItem._id}`,
        userId: '',
        type: 'info',
        actionType: 'borrowing',
        actionId: String(createdItem._id),
        title: 'Giao dịch mới',
        message: `${actorName} đã tạo giao dịch ${createdItem.type === 'internal' ? 'nội bộ' : 'cho thuê'} cho ${assetName}`,
        isRead: false,
        createdAt: new Date().toISOString(),
    });

    return sendSerializedItem(
        res,
        createdItem,
        serializeBorrowing,
        'Tao giao dich thiet bi thanh cong',
        StatusCodes.CREATED
    );
};

export const returnBorrowing = async (req: Request, res: Response, next: NextFunction) => {
    const borrowingId = getParamValue(req.params.id);
    const currentItem = await borrowingRepository.findById(borrowingId);

    if (!currentItem) throw new NotFoundError('Khong tim thay giao dich thiet bi');
    if (currentItem.status !== 'active') {
        throw new BadRequestError('Chi co the tra thiet bi cho giao dich dang hoat dong');
    }

    const item = await borrowingRepository.updateById(borrowingId, {
        returnTime: req.body.returnTime,
        returnNote: trimText(req.body.note),
        status: 'returned',
        returnedBy: req.userId,
    });

    if (!item) throw new NotFoundError('Khong tim thay giao dich thiet bi');

    await Asset.findByIdAndUpdate(toDocumentId(item.assetId), {
        status:
            item.assetStatusBefore === ASSET_STATUS.BORROWING || !item.assetStatusBefore
                ? ASSET_STATUS.ACTIVE
                : item.assetStatusBefore,
        updatedBy: req.userId,
    });

    // Send notification to admins about returned device
    const assetName = (item.assetId as any)?.name || 'Thiết bị';
    const actorName = await getActorName(req.userId);
    await notifyAdmins('notify:new', {
        _id: `return-${item._id}`,
        userId: '',
        type: 'success',
        actionType: 'borrowing',
        actionId: String(item._id),
        title: 'Thiết bị đã được trả',
        message: `${actorName} đã xác nhận trả ${assetName} về kho`,
        isRead: false,
        createdAt: new Date().toISOString(),
    });

    return sendSerializedItem(res, item, serializeBorrowing, 'Xac nhan tra thiet bi thanh cong');
};
