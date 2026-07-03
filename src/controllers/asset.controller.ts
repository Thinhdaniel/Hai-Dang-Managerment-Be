import { assetService, machineCodeService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const createAsset = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.createAsset(req, res, next);
});

export const getAllAssets = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.getAllAssets(req, res, next);
});

export const exportAssets = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.exportAssets(req, res, next);
});

export const getAssetNames = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.getAssetNames(req, res, next);
});

export const getAssetModels = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.getAssetModels(req, res, next);
});

export const getAssetTypes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.getAssetTypes(req, res, next);
});

export const getAssetById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.getAssetById(req, res, next);
});

export const ensureAssetPublicId = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.ensureAssetPublicId(req, res, next);
});

export const getPublicAssetByPublicId = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.getPublicAssetByPublicId(req, res, next);
});

export const updateAsset = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.updateAsset(req, res, next);
});

export const updateAssetStatus = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.updateAssetStatus(req, res, next);
});

export const deleteAsset = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.deleteAsset(req, res, next);
});

export const previewAssetImportFile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.previewAssetImportFile(req, res, next);
});

export const confirmAssetImportFile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await assetService.confirmAssetImportFile(req, res, next);
});

export const suggestAssetCode = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await machineCodeService.suggestAssetCode(req, res, next);
});

export const previewNormalizeAssetCodes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await machineCodeService.previewNormalizeAssetCodes(req, res, next);
});

export const confirmNormalizeAssetCodes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await machineCodeService.confirmNormalizeAssetCodes(req, res, next);
});

export const listMachineTypeCodes = asyncHandler(async (req: Request, res: Response) => {
    return await machineCodeService.listMachineTypeCodes(req, res);
});

export const saveMachineTypeCodes = asyncHandler(async (req: Request, res: Response) => {
    return await machineCodeService.saveMachineTypeCodes(req, res);
});

export const aiSuggestMachineTypeCodes = asyncHandler(async (req: Request, res: Response) => {
    return await machineCodeService.aiSuggestMachineTypeCodes(req, res);
});
