import * as supplyShortageService from '@/services/supply-shortage.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllSupplyShortages = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyShortageService.getAllSupplyShortages(req, res, next);
});

export const getSupplyShortageById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyShortageService.getSupplyShortageById(req, res, next);
});
