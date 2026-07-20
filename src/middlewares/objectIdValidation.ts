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

/** Chỉ kiểm tra các param được chỉ định, dùng cho route có cả ObjectId và khóa nghiệp vụ như `08:00`. */
export const validateObjectIdParams = (...paramNames: string[]): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
        for (const paramName of paramNames) {
            const value = req.params?.[paramName];
            if (!value || !mongoose.isValidObjectId(value)) {
                return next(new NotFoundError(`Invalid param: ${value ?? paramName}`));
            }
        }
        return next();
    };
};
