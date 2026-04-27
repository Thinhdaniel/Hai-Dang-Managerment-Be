import { brandService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const createBrand = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await brandService.createBrand(req, res, next);
});

export const getAllBrands = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await brandService.getAllBrands(req, res, next);
});

export const getBrandById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await brandService.getBrandById(req, res, next);
});

export const updateBrand = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await brandService.updateBrand(req, res, next);
});

export const deleteBrand = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await brandService.deleteBrand(req, res, next);
});
