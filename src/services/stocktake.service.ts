import StocktakeSession from '@/models/StocktakeSession';
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
    const item = await StocktakeSession.create({
        ...req.body,
        createdBy: req.userId,
    });

    const createdItem = await StocktakeSession.findById(item._id)
        .populate('plantId', 'name code')
        .populate('createdBy', 'fullname username email');

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

    return sendSerializedPage(res, items, total, page, limit, serializeStocktakeSession, 'Lay lich su kiem ke thanh cong');
};
