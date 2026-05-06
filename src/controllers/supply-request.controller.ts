import * as supplyRequestService from '@/services/supply-request.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllSupplyRequests = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.getAllSupplyRequests(req, res, next);
});
export const getSupplyRequestById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.getSupplyRequestById(req, res, next);
});
export const createSupplyRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.createSupplyRequest(req, res, next);
});
export const updateSupplyRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.updateSupplyRequest(req, res, next);
});
export const approveAndDistribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.approveAndDistribute(req, res, next);
});
export const approveSupplyRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.approveSupplyRequest(req, res, next);
});
export const rejectSupplyRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.rejectSupplyRequest(req, res, next);
});
export const exportSupplyRequestXlsx = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await supplyRequestService.exportSupplyRequestXlsx(req, res, next);
});
