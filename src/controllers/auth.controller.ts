import { authService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const Login = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.login(req, res, next);
});

export const Register = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.register(req, res, next);
});

export const RefreshToken = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.refreshToken(req, res, next);
});

export const Logout = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.logout(req, res, next);
});

export const ForgotPassword = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.forgotPassword(req, res, next);
});

export const ResetPassword = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.resetPassword(req, res, next);
});

export const ChangePassword = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await authService.changePassword(req, res, next);
});
