import { NotFoundError } from '@/errors/customError';
import { buildPaginatedResponse } from '@/utils/pagination';
import customResponse from '@/utils/response';
import type { Response } from 'express';
import { StatusCodes } from 'http-status-codes';

type PopulateOption = string | { path: string; populate?: readonly string[] };

type SerializeFn<TInput, TOutput> = (input: TInput) => TOutput;

export const WORKFLOW_POPULATE = {
    maintenance: [{ path: 'assetId', populate: ['brandId', 'plantId'] }, 'plantId'],
    transfer: [
        { path: 'assetId', populate: ['brandId', 'plantId'] },
        { path: 'assetIds', populate: ['brandId', 'plantId'] },
        'fromPlantId',
        'toPlantId',
    ],
    borrowing: [
        { path: 'assetId', populate: ['brandId', 'plantId'] },
        { path: 'borrowerId', populate: ['plantId'] },
    ],
} as const;

export const applyPopulate = (query: any, options: readonly PopulateOption[]) => {
    return options.reduce((currentQuery, option) => currentQuery.populate(option), query);
};

export const findOnePopulatedOrThrow = async ({
    model,
    filter,
    populate,
    notFoundMessage,
}: {
    model: any;
    filter: Record<string, unknown>;
    populate: readonly PopulateOption[];
    notFoundMessage: string;
}) => {
    const item = await applyPopulate(model.findOne(filter), populate);

    if (!item) {
        throw new NotFoundError(notFoundMessage);
    }

    return item;
};

export const sendSuccess = <T>(res: Response, data: T, message: string, status = StatusCodes.OK) => {
    return res.status(status).json(
        customResponse({
            data,
            message,
            status,
            success: true,
        })
    );
};

export const sendSerializedItem = <TInput, TOutput>(
    res: Response,
    item: TInput,
    serializer: SerializeFn<TInput, TOutput>,
    message: string,
    status = StatusCodes.OK
) => {
    return sendSuccess(res, serializer(item), message, status);
};

export const sendSerializedList = <TInput, TOutput>(
    res: Response,
    items: TInput[],
    serializer: SerializeFn<TInput, TOutput>,
    message: string,
    status = StatusCodes.OK
) => {
    return sendSuccess(res, items.map(serializer), message, status);
};

export const sendSerializedPage = <TInput, TOutput>(
    res: Response,
    items: TInput[],
    total: number,
    page: number,
    limit: number,
    serializer: SerializeFn<TInput, TOutput>,
    message: string
) => {
    return sendSuccess(res, buildPaginatedResponse(items.map(serializer), total, page, limit), message);
};
