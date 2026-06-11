import QrScanLog from '@/models/QrScanLog';
import { getPagination } from '@/utils/pagination';
import { sendSuccess } from './service.helpers';
import type { NextFunction, Request, Response } from 'express';
import { buildPaginatedResponse } from '@/utils/pagination';

const toId = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const toIso = (value: any) => (value ? new Date(value).toISOString() : undefined);

const serializeQrScanLog = (input: any) => {
    const log = typeof input?.toObject === 'function' ? input.toObject() : input;
    const asset = log?.assetId && typeof log.assetId === 'object' ? log.assetId : undefined;
    const actor = log?.actorId && typeof log.actorId === 'object' ? log.actorId : undefined;

    return {
        id: toId(log),
        rawValue: log?.rawValue,
        publicId: log?.publicId,
        labelId: toId(log?.labelId),
        assetId: asset ? toId(asset) : toId(log?.assetId),
        asset: asset
            ? {
                  id: toId(asset),
                  name: asset.name,
                  machineCode: asset.machineCode,
                  area: asset.area,
              }
            : undefined,
        action: log?.action,
        result: log?.result,
        source: log?.source,
        actorId: actor ? toId(actor) : toId(log?.actorId),
        actor: actor
            ? {
                  id: toId(actor),
                  name: actor.fullname ?? actor.name ?? actor.username,
                  email: actor.email,
              }
            : undefined,
        actorRole: log?.actorRole,
        ip: log?.ip,
        userAgent: log?.userAgent,
        metadata: log?.metadata ?? {},
        createdAt: toIso(log?.createdAt),
        updatedAt: toIso(log?.updatedAt),
    };
};

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, unknown> = {};
    if (query.assetId) filter.assetId = query.assetId;
    if (query.publicId) filter.publicId = String(query.publicId).trim().toUpperCase();
    if (query.action) filter.action = query.action;
    if (query.result) filter.result = query.result;

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

export const createQrScanLog = async (req: Request, res: Response, next: NextFunction) => {
    const userAgentHeader = req.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader.join(' ') : userAgentHeader;

    const log = await QrScanLog.create({
        ...req.body,
        publicId: req.body.publicId ? String(req.body.publicId).trim().toUpperCase() : undefined,
        actorId: req.userId,
        actorRole: req.role,
        ip: req.ip,
        userAgent,
    });

    return sendSuccess(res, serializeQrScanLog(log), 'Da ghi nhan lich su quet QR', 201);
};

export const getQrScanLogs = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [items, total] = await Promise.all([
        QrScanLog.find(filter)
            .populate('assetId', 'name machineCode area')
            .populate('actorId', 'fullname username email')
            .sort('-createdAt')
            .skip(skip)
            .limit(limit),
        QrScanLog.countDocuments(filter),
    ]);

    return sendSuccess(
        res,
        buildPaginatedResponse(items.map(serializeQrScanLog), total, page, limit),
        'Lay lich su quet QR thanh cong'
    );
};
