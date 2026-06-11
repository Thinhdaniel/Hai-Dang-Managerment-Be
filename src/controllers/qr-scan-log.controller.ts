import { qrScanLogService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import type { NextFunction, Request, Response } from 'express';

export const createQrScanLog = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrScanLogService.createQrScanLog(req, res, next);
});

export const getQrScanLogs = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await qrScanLogService.getQrScanLogs(req, res, next);
});
