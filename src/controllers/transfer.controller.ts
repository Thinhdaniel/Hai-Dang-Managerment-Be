import { transferService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const createTransfer = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.createTransfer(req, res, next);
});

export const getAllTransfers = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.getAllTransfers(req, res, next);
});

export const getTransferByAsset = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.getTransferByAsset(req, res, next);
});

export const getTransferById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.getTransferById(req, res, next);
});

export const approveTransfer = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.approveTransfer(req, res, next);
});

export const rejectTransfer = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.rejectTransfer(req, res, next);
});

export const completeTransfer = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.completeTransfer(req, res, next);
});

export const cancelTransfer = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await transferService.cancelTransfer(req, res, next);
});
