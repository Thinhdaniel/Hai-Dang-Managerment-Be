import { ASSET_STATUS } from '@/constant/assetStatus';
import { NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import { getPagination } from '@/utils/pagination';
import { serializeMaintenance } from '@/utils/serializers';
import {
    WORKFLOW_POPULATE,
    applyPopulate,
    findOnePopulatedOrThrow,
    sendSerializedItem,
    sendSerializedList,
    sendSerializedPage,
    sendSuccess,
} from './service.helpers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

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
    const item = await Maintenance.create({
        ...req.body,
        createdBy: req.userId,
        status: req.body.endDate ? 'completed' : 'in_progress',
    });

    await Asset.findByIdAndUpdate(req.body.assetId, {
        status: ASSET_STATUS.MAINTENANCE,
    });

    const createdItem = await findOnePopulatedOrThrow({
        model: Maintenance,
        filter: { _id: item._id },
        populate: WORKFLOW_POPULATE.maintenance,
        notFoundMessage: 'Khong tim thay phieu bao tri',
    });

    return sendSerializedItem(
        res,
        createdItem,
        serializeMaintenance,
        'Tao phieu bao tri thanh cong',
        StatusCodes.CREATED
    );
};

export const updateMaintenance = async (req: Request, res: Response, next: NextFunction) => {
    const item = await applyPopulate(
        Maintenance.findOneAndUpdate({ _id: req.params.id, isDeleted: { $ne: true } }, req.body, {
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
    const item = await applyPopulate(
        Maintenance.findOneAndUpdate(
            { _id: req.params.id, isDeleted: { $ne: true } },
            {
                status: 'completed',
                endDate: req.body.endDate,
                note: req.body.note,
                cost: req.body.cost,
            },
            { new: true, runValidators: true }
        ),
        WORKFLOW_POPULATE.maintenance
    );

    if (!item) throw new NotFoundError('Khong tim thay phieu bao tri');

    await Asset.findByIdAndUpdate(item.assetId, {
        status: ASSET_STATUS.ACTIVE,
        lastMaintenanceDate: req.body.endDate,
    });

    return sendSerializedItem(res, item, serializeMaintenance, 'Hoan thanh bao tri thanh cong');
};
