import { SYSTEM_MESSAGES } from '@/constant/messages';
import { NotFoundError } from '@/errors/customError';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
    const err = new NotFoundError(SYSTEM_MESSAGES.ROUTE_NOT_FOUND);
    err.status = StatusCodes.NOT_FOUND;
    next(err);
};

export default notFoundHandler;
