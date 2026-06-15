import config from '@/config/env.config';
import { USER_ROLE } from '@/constant/allowedRoles';
import { tokenTypes, TokenType } from '@/constant/token';
import { UnAuthenticatedError } from '@/errors/customError';
import UserSession from '@/models/UserSession';
import crypto from 'node:crypto';
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { Types } from 'mongoose';

type TUserPayload = {
    _id: Types.ObjectId;
    role: USER_ROLE;
};

export type AuthJwtPayload = {
    userId: string;
    role: string;
    sessionId: string;
    type: TokenType;
};

const signToken = (payload: AuthJwtPayload, key: string, expires: SignOptions['expiresIn']) => {
    return jwt.sign(payload, key, { expiresIn: expires });
};

const buildTokenPayload = (user: TUserPayload, sessionId: Types.ObjectId, type: TokenType): AuthJwtPayload => ({
    userId: String(user._id),
    role: user.role,
    sessionId: String(sessionId),
    type,
});

// Cap rieng access token cho mot session da co (dung khi refresh ma KHONG xoay vong refresh token)
export const generateAccessToken = (user: TUserPayload, sessionId: Types.ObjectId) =>
    signToken(
        buildTokenPayload(user, sessionId, tokenTypes.ACCESS),
        config.jwt.accessTokenKey,
        config.jwt.accessExpiration
    );

const generateSessionTokenPair = (user: TUserPayload, sessionId: Types.ObjectId) => {
    const accessToken = signToken(
        buildTokenPayload(user, sessionId, tokenTypes.ACCESS),
        config.jwt.accessTokenKey,
        config.jwt.accessExpiration
    );
    const refreshToken = signToken(
        buildTokenPayload(user, sessionId, tokenTypes.REFRESH),
        config.jwt.refreshTokenKey,
        config.jwt.refreshExpiration
    );

    return {
        accessToken,
        refreshToken,
        refreshTokenExpiresAt: getTokenExpiryDate(refreshToken),
    };
};

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const getTokenExpiryDate = (token: string) => {
    const decoded = jwt.decode(token);

    if (!decoded || typeof decoded === 'string' || !decoded.exp) {
        throw new UnAuthenticatedError('Token is missing expiration');
    }

    return new Date(decoded.exp * 1000);
};

export const createPasswordResetToken = () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.auth.resetPasswordTokenExpirationMinutes * 60 * 1000);

    return {
        token,
        tokenHash: hashToken(token),
        expiresAt,
    };
};

export const verifyAccessToken = (token: string) => {
    return jwt.verify(token, config.jwt.accessTokenKey) as JwtPayload & AuthJwtPayload;
};

export const verifyRefreshToken = (token: string) => {
    return jwt.verify(token, config.jwt.refreshTokenKey) as JwtPayload & AuthJwtPayload;
};

export const createUserSession = async (user: TUserPayload) => {
    const sessionId = new Types.ObjectId();
    const tokens = generateSessionTokenPair(user, sessionId);

    await UserSession.create({
        _id: sessionId,
        userId: user._id,
        refreshToken: hashToken(tokens.refreshToken),
        expireAt: tokens.refreshTokenExpiresAt,
    });

    return tokens;
};

export const rotateUserSession = async (session: any, user: TUserPayload) => {
    const tokens = generateSessionTokenPair(user, session._id);

    session.refreshToken = hashToken(tokens.refreshToken);
    session.expireAt = tokens.refreshTokenExpiresAt;
    session.revoked = false;
    session.revokedAt = undefined;
    await session.save();

    return tokens;
};

export const findSessionByRefreshToken = async (refreshToken: string) => {
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded || decoded.type !== tokenTypes.REFRESH || !decoded.sessionId) {
        throw new UnAuthenticatedError('Refresh token is invalid');
    }

    const session = await UserSession.findOne({
        _id: decoded.sessionId,
        userId: decoded.userId,
        revoked: { $ne: true },
        expireAt: { $gt: new Date() },
    });

    if (!session || session.refreshToken !== hashToken(refreshToken)) {
        throw new UnAuthenticatedError('Refresh token is invalid');
    }

    return {
        session,
        decoded,
    };
};

export const revokeSessionById = async (sessionId?: string) => {
    if (!sessionId || sessionId === 'auth-bypass') {
        return null;
    }

    return UserSession.findByIdAndUpdate(
        sessionId,
        {
            revoked: true,
            revokedAt: new Date(),
        },
        { new: true }
    );
};

export const revokeUserSessions = async (userId: string) => {
    return UserSession.updateMany(
        {
            userId,
            revoked: { $ne: true },
        },
        {
            revoked: true,
            revokedAt: new Date(),
        }
    );
};

export const generateAuthTokens = async (user: TUserPayload) => {
    return createUserSession(user);
};
