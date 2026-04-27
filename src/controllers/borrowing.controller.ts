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

export const returnBorrowing = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await borrowingService.returnBorrowing(req, res, next);
});
