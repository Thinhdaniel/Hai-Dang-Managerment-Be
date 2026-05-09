import * as inventoryService from '@/services/inventory.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getInventoryStocks = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.getInventoryStocks(req, res, next);
});

export const getInventoryByMaterial = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.getInventoryByMaterial(req, res, next);
});

export const getInventoryTransactions = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.getInventoryTransactions(req, res, next);
});

export const adjustInventory = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.adjustInventory(req, res, next);
});

export const overrideInventoryStock = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.overrideInventoryStock(req, res, next);
});

export const initializeStock = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.initializeStock(req, res, next);
});

export const importExcel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.importExcel(req, res, next);
});

export const previewInventoryImport = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.previewInventoryImport(req, res, next);
});

export const downloadTemplate = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.downloadTemplate(req, res, next);
});

export const exportExcel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await inventoryService.exportExcel(req, res, next);
});

