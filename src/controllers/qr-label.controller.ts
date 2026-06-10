import { qrLabelService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const createLabel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.createLabel(req, res, next);
});

export const createBatch = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.createBatch(req, res, next);
});

export const getLabels = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.getLabels(req, res, next);
});

export const getBatches = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.getBatches(req, res, next);
});

export const getBatchById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.getBatchById(req, res, next);
});

export const markBatchPrinted = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.markBatchPrinted(req, res, next);
});

export const resolvePublicQr = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.resolvePublicQr(req, res, next);
});

export const resolveInternalQr = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.resolveInternalQr(req, res, next);
});

export const activateMachineLabel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.activateMachineLabel(req, res, next);
});

export const linkAssetLabel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.linkAssetLabel(req, res, next);
});

export const retireLabel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrLabelService.retireLabel(req, res, next);
});
