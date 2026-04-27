import mongoose from 'mongoose';
import { NotFoundError } from '@/errors/customError';
import { Request, Response, NextFunction, RequestHandler } from 'express';

export const validateObjectId: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!req.params) {
        return next(new NotFoundError(`Need the request params for this route.`));
    }

    for (const value of Object.values(req.params)) {
        if (!mongoose.isValidObjectId(value)) {
            return next(new NotFoundError(`Invalid param: ${value}`));
        }
    }

    return next();
};
