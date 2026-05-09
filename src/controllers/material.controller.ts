import * as materialService from '@/services/material.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllMaterials = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getAllMaterials(req, res, next);
});

export const getMaterialById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getMaterialById(req, res, next);
});

export const createMaterial = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.createMaterial(req, res, next);
});

export const updateMaterial = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.updateMaterial(req, res, next);
});

export const deleteMaterial = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.deleteMaterial(req, res, next);
});

export const getLowStockMaterials = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getLowStockMaterials(req, res, next);
});

export const getMaterialReportsSummary = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getMaterialReportsSummary(req, res, next);
});

export const getMaterialCostByPeriodReport = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getMaterialCostByPeriodReport(req, res, next);
});

export const getMaterialReportBySupplier = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getMaterialReportBySupplier(req, res, next);
});

export const getMaterialPriceComparisonReport = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
        return await materialService.getMaterialPriceComparisonReport(req, res, next);
    }
);


export const getTopMaterials = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getTopMaterials(req, res, next);
});

export const exportMaterialCatalogExcel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.exportMaterialCatalogExcel(req, res, next);
});

export const downloadMaterialImportTemplate = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.downloadMaterialImportTemplate(req, res, next);
});

export const previewMaterialImport = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.previewMaterialImport(req, res, next);
});

export const confirmMaterialImport = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.confirmMaterialImport(req, res, next);
});

export const exportMaterialReportExcel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.exportMaterialReportExcel(req, res, next);
});

export const getDistributionCostReport = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await materialService.getDistributionCostReport(req, res, next);
});