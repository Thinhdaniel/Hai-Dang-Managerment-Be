import { ACCESS_MESSAGES } from '@/constant/messages';
import { UnAuthorizedError } from '@/errors/customError';
import { NextFunction, Request, Response } from 'express';

export const authorize = (...allowedRoles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.role && allowedRoles.includes(req.role)) {
            return next();
        }

        return next(new UnAuthorizedError(ACCESS_MESSAGES.PERMISSION_DENIED));
    };
};
