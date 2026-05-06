import { USER_ROLE } from '@/constant/allowedRoles';
import { AUTH_MESSAGES } from '@/constant/messages';
import { tokenTypes } from '@/constant/token';
import config from '@/config/env.config';
import { UnAuthenticatedError, UnAuthorizedError } from '@/errors/customError';
import User from '@/models/User';
import UserSession from '@/models/UserSession';
import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';

interface IAuthJwtPayload extends JwtPayload {
    userId: string;
    role: string;
    sessionId: string;
    type: string;
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const hasBearerToken = Boolean(authHeader && authHeader.startsWith('Bearer '));

    if (config.auth.bypass && !hasBearerToken) {
        req.userId = '000000000000000000000000';
        req.userSessionId = 'auth-bypass';
        req.role = USER_ROLE.ADMIN;
        // Inject a minimal mock user so getUserPlantId() works in bypass mode.
        // Use BYPASS_PLANT_ID env or fall back to the second plant in the system.
        const bypassPlantId = process.env.BYPASS_PLANT_ID || '69f08c145d6c65fb152f347f';
        req.user = { plantId: bypassPlantId } as any;
        return next();
    }

    if (!hasBearerToken) {
        return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_INVALID));
    }

    const bearerHeader = authHeader as string;
    const token = bearerHeader.split(' ')[1];

    if (!token) {
        return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_INVALID));
    }

    try {
        const decoded = jwt.verify(token, config.jwt.accessTokenKey) as unknown as IAuthJwtPayload;

        if (!decoded || typeof decoded === 'string' || decoded.type !== tokenTypes.ACCESS || !decoded.sessionId) {
            return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_INVALID));
        }

        const [session, user] = await Promise.all([
            UserSession.findOne({
                _id: decoded.sessionId,
                userId: decoded.userId,
                revoked: { $ne: true },
                expireAt: { $gt: new Date() },
            }),
            User.findOne({
                _id: decoded.userId,
                isDeleted: { $ne: true },
            }).populate('plantId'),
        ]);

        if (!session || !user || !user.isActive) {
            return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_INVALID));
        }

        if (decoded.iat && user.passwordChangedAt) {
            const issuedAt = decoded.iat * 1000;
            if (user.passwordChangedAt.getTime() > issuedAt) {
                return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_INVALID));
            }
        }

        req.userId = String(user._id);
        req.userSessionId = String(session._id);
        req.role = user.role;
        req.user = user;

        return next();
    } catch (error: any) {
        if (error?.name === 'TokenExpiredError') {
            return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_EXPIRED));
        }
        if (error?.name === 'JsonWebTokenError') {
            return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_INVALID));
        }
        return next(new UnAuthenticatedError(AUTH_MESSAGES.TOKEN_VALIDATION_FAILED));
    }
};


const MAIN_PLANT_ID = process.env.MAIN_PLANT_ID || '';

const resolveUserPlantId = (req: Request): string => {
    if (!req.user || typeof req.user !== 'object') return '';
    const u = req.user as any;
    return String(u.plantId?._id ?? u.plantId ?? '');
};

/** admin | manager | director thuộc CS1 */
export const requireCS1Manager = (req: Request, res: Response, next: NextFunction) => {
    const isCS1 = MAIN_PLANT_ID && resolveUserPlantId(req) === MAIN_PLANT_ID;
    const hasRole = [USER_ROLE.ADMIN, USER_ROLE.MANAGER, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE);
    if (!isCS1 || !hasRole) {
        return next(new UnAuthorizedError('Chi quan ly co so chinh moi co quyen thuc hien'));
    }
    return next();
};

/** Chỉ admin | director thuộc CS1 mới duyệt được */
export const requireCS1Director = (req: Request, res: Response, next: NextFunction) => {
    const isCS1 = MAIN_PLANT_ID && resolveUserPlantId(req) === MAIN_PLANT_ID;
    const hasRole = [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE);
    if (!isCS1 || !hasRole) {
        return next(new UnAuthorizedError('Chi Giam doc hoac Quan tri vien moi co quyen duyet'));
    }
    return next();
};
