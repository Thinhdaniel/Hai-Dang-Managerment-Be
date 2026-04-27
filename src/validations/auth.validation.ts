import { zObjectId, zOptionalString, zPassword, zRequiredEmail, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const loginSchema = z.object({
    email: zRequiredEmail(),
    password: zPassword(),
});

export const registerSchema = z.object({
    fullname: zRequiredString('Ho va ten'),
    username: zRequiredString('Ten dang nhap', 3).optional(),
    email: zRequiredEmail(),
    password: zPassword(),
    phone: zOptionalString(),
    plantId: zObjectId('Co so').optional(),
});

export const forgotPasswordSchema = z.object({
    email: zRequiredEmail(),
});

export const resetPasswordSchema = z.object({
    token: zRequiredString('Reset token'),
    password: zPassword(),
});

export const changePasswordSchema = z
    .object({
        currentPassword: zPassword('Mat khau hien tai'),
        newPassword: zPassword('Mat khau moi'),
    })
    .refine((data) => data.currentPassword !== data.newPassword, {
        message: 'Mat khau moi phai khac mat khau hien tai',
        path: ['newPassword'],
    });
