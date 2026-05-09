import * as distributionService from '@/services/distribution.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllDistributionRecords = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.getAllDistributionRecords(req, res, next);
});
export const getDistributionRecordById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.getDistributionRecordById(req, res, next);
});
export const createDistributionRecord = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.createDistributionRecord(req, res, next);
});
export const distributeDistributionRecord = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.distributeRecord(req, res, next);
});
export const confirmDistributionRecord = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.confirmDistributionRecord(req, res, next);
});
export const updateDistributionRecord = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.updateDistributionRecord(req, res, next);
});
export const exportDistributionXlsx = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await distributionService.exportDistributionXlsx(req, res, next);
});
