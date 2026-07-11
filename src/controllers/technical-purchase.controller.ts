import * as technicalPurchaseService from '@/services/technical-purchase.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllTechnicalPurchaseRequests = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.getAllTechnicalPurchaseRequests(req, res, next)
);
export const getTechnicalPurchaseRequestById = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.getTechnicalPurchaseRequestById(req, res, next)
);
export const createTechnicalPurchaseRequest = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.createTechnicalPurchaseRequest(req, res, next)
);
export const updateTechnicalPurchaseRequest = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.updateTechnicalPurchaseRequest(req, res, next)
);
export const approveTechnicalPurchaseRequest = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.approveTechnicalPurchaseRequest(req, res, next)
);
export const rejectTechnicalPurchaseRequest = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.rejectTechnicalPurchaseRequest(req, res, next)
);
export const exportTechnicalPurchaseRequestXlsx = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.exportTechnicalPurchaseRequestXlsx(req, res, next)
);
export const getTechnicalMaterialSuggestions = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) =>
        technicalPurchaseService.getTechnicalMaterialSuggestions(req, res, next)
);
