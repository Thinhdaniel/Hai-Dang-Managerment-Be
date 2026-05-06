import * as purchaseRequestService from '@/services/purchase-request.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllPurchaseRequests = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.getAllPurchaseRequests(req, res, next);
});

export const getPurchaseRequestById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.getPurchaseRequestById(req, res, next);
});

export const createPurchaseRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.createPurchaseRequest(req, res, next);
});

export const updatePurchaseRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.updatePurchaseRequest(req, res, next);
});

export const deletePurchaseRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.deletePurchaseRequest(req, res, next);
});

export const approvePurchaseRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.approvePurchaseRequest(req, res, next);
});

export const rejectPurchaseRequest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.rejectPurchaseRequest(req, res, next);
});

export const getPendingPurchaseRequests = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.getPendingPurchaseRequests(req, res, next);
});

export const consolidatePurchaseRequests = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.consolidatePurchaseRequests(req, res, next);
});

export const exportPurchaseRequestXlsx = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseRequestService.exportPurchaseRequestXlsx(req, res, next);
});
