import config from '@/config/env.config';
import { AUTH_MESSAGES } from '@/constant/messages';
import { BadRequestError, NotFoundError, UnAuthenticatedError } from '@/errors/customError';
import User from '@/models/User';
import { sendPasswordResetEmail } from '@/services/mail.service';
import {
    createPasswordResetToken,
    findSessionByRefreshToken,
    generateAuthTokens,
    getTokenExpiryDate,
    hashToken,
    revokeSessionById,
    revokeUserSessions,
    verifyAccessToken,
} from '@/services/token.service';
import customResponse from '@/utils/response';
import { serializeUser } from '@/utils/serializers';
import { buildUniqueUsername } from '@/utils/usernames';
import bcrypt from 'bcryptjs';
import { CookieOptions, NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const normalizeEmail = (value: string) => String(value).trim().toLowerCase();

const buildRefreshCookieOptions = (refreshToken: string): CookieOptions => {
    const secure = config.auth.cookieSecure || config.auth.cookieSameSite === 'none';

    return {
        httpOnly: true,
        secure,
        sameSite: config.auth.cookieSameSite as CookieOptions['sameSite'],
        expires: getTokenExpiryDate(refreshToken),
        path: '/',
    };
};

const clearRefreshTokenCookie = (res: Response) => {
    const secure = config.auth.cookieSecure || config.auth.cookieSameSite === 'none';

    res.clearCookie(config.auth.refreshTokenCookieName, {
        httpOnly: true,
        secure,
        sameSite: config.auth.cookieSameSite as CookieOptions['sameSite'],
        path: '/',
    });
};

const setRefreshTokenCookie = (res: Response, refreshToken: string) => {
    res.cookie(config.auth.refreshTokenCookieName, refreshToken, buildRefreshCookieOptions(refreshToken));
};

const extractRefreshToken = (req: Request) => {
    const cookieToken = req.cookies?.[config.auth.refreshTokenCookieName];
    const bodyToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;

    return cookieToken || bodyToken;
};

const buildAuthResponse = (user: any, accessToken: string) => ({
    user: serializeUser(user),
    access_token: accessToken,
});

const issueSession = async (res: Response, user: any) => {
    const tokens = await generateAuthTokens({
        _id: user._id,
        role: user.role,
    });

    setRefreshTokenCookie(res, tokens.refreshToken);

    return tokens;
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
    const { password } = req.body;
    const email = normalizeEmail(req.body.email);

    const foundedUser = await User.findOne({ email, isDeleted: { $ne: true } }).populate('plantId');

    if (!foundedUser) {
        throw new BadRequestError(AUTH_MESSAGES.LOGIN_FAILED);
    }

    const isMatch = await bcrypt.compare(password, foundedUser.password);
    if (!isMatch) throw new BadRequestError(AUTH_MESSAGES.LOGIN_FAILED);

    if (!foundedUser.isActive) throw new UnAuthenticatedError(AUTH_MESSAGES.USER_NOT_ACTIVE);

    const { accessToken } = await issueSession(res, foundedUser);

    foundedUser.lastLoginAt = new Date();
    await foundedUser.save();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildAuthResponse(foundedUser, accessToken),
            message: AUTH_MESSAGES.LOGIN_SUCCESS,
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const register = async (req: Request, res: Response, next: NextFunction) => {
    const email = normalizeEmail(req.body.email);
    const username =
        req.body.username ?? (await buildUniqueUsername(req.body.fullname ?? req.body.name ?? email.split('@')[0]));

    const existingUser = await User.findOne({
        $or: [{ email }, { username }],
        isDeleted: { $ne: true },
    });

    if (existingUser) {
        throw new BadRequestError(AUTH_MESSAGES.USER_ALREADY_EXISTS);
    }

    const newUser = await User.create({
        ...req.body,
        email,
        username,
        fullname: req.body.fullname ?? req.body.name,
    });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeUser(newUser),
            message: AUTH_MESSAGES.REGISTER_SUCCESS,
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction) => {
    const refreshTokenValue = extractRefreshToken(req);

    if (!refreshTokenValue) {
        throw new UnAuthenticatedError('Refresh token is required');
    }

    const { session, decoded } = await findSessionByRefreshToken(refreshTokenValue);
    const user = await User.findOne({
        _id: decoded.userId,
        isDeleted: { $ne: true },
    }).populate('plantId');

    if (!user || !user.isActive) {
        await revokeSessionById(String(session._id));
        clearRefreshTokenCookie(res);
        throw new UnAuthenticatedError(AUTH_MESSAGES.USER_NOT_ACTIVE);
    }

    const tokens = await issueSession(res, user);
    await revokeSessionById(String(session._id));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildAuthResponse(user, tokens.accessToken),
            message: 'Lam moi phien dang nhap thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const logout = async (req: Request, res: Response, next: NextFunction) => {
    const refreshTokenValue = extractRefreshToken(req);
    const authHeader = req.headers.authorization;

    if (refreshTokenValue) {
        try {
            const { session } = await findSessionByRefreshToken(refreshTokenValue);
            await revokeSessionById(String(session._id));
        } catch {}
    } else if (authHeader?.startsWith('Bearer ')) {
        try {
            const accessToken = authHeader.split(' ')[1];
            const decoded = verifyAccessToken(accessToken);
            await revokeSessionById(decoded.sessionId);
        } catch {}
    }

    clearRefreshTokenCookie(res);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Dang xuat thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
    const email = normalizeEmail(req.body.email);
    const user = await User.findOne({
        email,
        isDeleted: { $ne: true },
        isActive: true,
    }).populate('plantId');

    if (user) {
        const { token, tokenHash, expiresAt } = createPasswordResetToken();
        const baseResetUrl = config.app.resetPasswordUrl || `${config.app.clientUrl.replace(/\/$/, '')}/reset-password`;
        const resetUrl = `${baseResetUrl}?token=${encodeURIComponent(token)}`;

        user.passwordResetToken = tokenHash;
        user.passwordResetExpiresAt = expiresAt;
        await user.save();

        await sendPasswordResetEmail({
            to: user.email,
            name: user.fullname || user.username,
            resetUrl,
        });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Neu email ton tai trong he thong, huong dan dat lai mat khau da duoc gui',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
    const tokenHash = hashToken(String(req.body.token));
    const user = await User.findOne({
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() },
        isDeleted: { $ne: true },
    })
        .select('+passwordResetToken +passwordResetExpiresAt')
        .populate('plantId');

    if (!user) {
        throw new BadRequestError('Reset password token is invalid or expired');
    }

    user.password = req.body.password;
    user.passwordResetToken = undefined;
    user.passwordResetExpiresAt = undefined;
    await user.save();

    await revokeUserSessions(String(user._id));

    const { accessToken } = await issueSession(res, user);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildAuthResponse(user, accessToken),
            message: 'Dat lai mat khau thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const changePassword = async (req: Request, res: Response, next: NextFunction) => {
    const user = await User.findOne({
        _id: req.userId,
        isDeleted: { $ne: true },
    }).populate('plantId');

    if (!user) {
        throw new NotFoundError(AUTH_MESSAGES.USER_NOT_FOUND);
    }

    const isCurrentPasswordValid = await bcrypt.compare(req.body.currentPassword, user.password);
    if (!isCurrentPasswordValid) {
        throw new BadRequestError('Mat khau hien tai khong chinh xac');
    }

    const isSamePassword = await bcrypt.compare(req.body.newPassword, user.password);
    if (isSamePassword) {
        throw new BadRequestError('Mat khau moi phai khac mat khau hien tai');
    }

    user.password = req.body.newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpiresAt = undefined;
    await user.save();

    await revokeUserSessions(String(user._id));

    const { accessToken } = await issueSession(res, user);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildAuthResponse(user, accessToken),
            message: 'Doi mat khau thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
