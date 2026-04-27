import { USER_ROLE } from '@/constant/allowedRoles';
import { AUTH_MESSAGES } from '@/constant/messages';
import { tokenTypes } from '@/constant/token';
import config from '@/config/env.config';
import { UnAuthenticatedError } from '@/errors/customError';
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
