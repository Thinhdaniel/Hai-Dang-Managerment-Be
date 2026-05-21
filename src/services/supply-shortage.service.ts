import { NotFoundError } from '@/errors/customError';
import SupplyShortage from '@/models/SupplyShortage';
import { getUserPlantId, isManagerRole } from '@/services/material-workflow.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializeSupplyShortage } from '@/utils/materialSerializers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [
            { originalSupplyRequestCode: regex },
            { originalDistributionCode: regex },
            { materialName: regex },
            { reason: regex },
            { note: regex },
        ];
    }

    if (query.status) filter.status = query.status;
    if (query.originalSupplyRequestId) filter.originalSupplyRequestId = query.originalSupplyRequestId;
    if (query.originalDistributionId) filter.originalDistributionId = query.originalDistributionId;
    if (query.toPlantId) filter.toPlantId = query.toPlantId;

    if (!isManagerRole(req.role)) {
        filter.toPlantId = getUserPlantId(req);
    }

    return filter;
};

const withPopulate = (query: any) =>
    query
        .populate('toPlantId')
        .populate('materialId')
        .populate('originalSupplyRequestId')
        .populate('originalDistributionId')
        .populate('resolutions.distributionId');

export const getAllSupplyShortages = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || '-createdAt').split(',').join(' ');

    const [items, total] = await Promise.all([
        withPopulate(SupplyShortage.find(filter)).sort(sort).skip(skip).limit(limit),
        SupplyShortage.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(items.map(serializeSupplyShortage), total, page, limit),
            message: 'Lay danh sach vat tu can cap bu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getSupplyShortageById = async (req: Request, res: Response, next: NextFunction) => {
    const item = await withPopulate(SupplyShortage.findOne({ _id: req.params.id, isDeleted: { $ne: true } }));
    if (!item) throw new NotFoundError('Khong tim thay dong cap bu');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeSupplyShortage(item),
            message: 'Lay chi tiet dong cap bu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
