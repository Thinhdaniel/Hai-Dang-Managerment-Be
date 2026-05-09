import asyncHandler from '@/utils/asyncHandler';
import * as service from '@/services/return-record.service';
import { NextFunction, Request, Response } from 'express';

export const createReturnRecord = asyncHandler((req: Request, res: Response, next: NextFunction) =>
    service.createReturnRecord(req, res, next));

export const getReturnsByPurchaseOrder = asyncHandler((req: Request, res: Response, next: NextFunction) =>
    service.getReturnsByPurchaseOrder(req, res, next));

export const getAllReturnRecords = asyncHandler((req: Request, res: Response, next: NextFunction) =>
    service.getAllReturnRecords(req, res, next));
