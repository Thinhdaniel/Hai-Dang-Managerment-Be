import * as materialSupplierService from '@/services/material-supplier.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllMaterialSuppliers = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialSupplierService.getAllMaterialSuppliers(req, res, next);
});

export const createMaterialSupplier = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialSupplierService.createMaterialSupplier(req, res, next);
});

export const updateMaterialSupplier = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialSupplierService.updateMaterialSupplier(req, res, next);
});
