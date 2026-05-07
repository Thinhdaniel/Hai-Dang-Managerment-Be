import * as expressDispatchService from '@/services/express-dispatch.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const expressDispatch = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await expressDispatchService.expressDispatch(req, res, next);
});
