import { borrowingService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const createBorrowing = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.createBorrowing(req, res, next);
});

export const getAllBorrowings = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.getAllBorrowings(req, res, next);
});

export const getBorrowingByAsset = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.getBorrowingByAsset(req, res, next);
});

export const getBorrowingById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.getBorrowingById(req, res, next);
});

export const getAllBorrowingBatches = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.getAllBorrowingBatches(req, res, next);
});

export const createBorrowingBatch = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.createBorrowingBatch(req, res, next);
});

export const getBorrowingBatchById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.getBorrowingBatchById(req, res, next);
});

export const updateBorrowingBatch = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.updateBorrowingBatch(req, res, next);
});

export const getBorrowingBatchStats = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.getBorrowingBatchStats(req, res, next);
});

export const exportBorrowingBatchHandover = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.exportBorrowingBatchHandover(req, res, next);
});

export const createBorrowingBatchQr = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.createBorrowingBatchQr(req, res, next);
});

export const receiveBorrowingBatchByQr = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.receiveBorrowingBatchByQr(req, res, next);
});

export const receiveBorrowingBatchBulk = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.receiveBorrowingBatchBulk(req, res, next);
});

export const bulkReturnBorrowingBatch = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.bulkReturnBorrowingBatch(req, res, next);
});

export const returnBorrowing = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.returnBorrowing(req, res, next);
});
