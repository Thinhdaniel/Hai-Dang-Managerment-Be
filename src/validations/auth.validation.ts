import { zObjectId, zOptionalString, zPassword, zRequiredEmail, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const loginSchema = z.object({
    email: z.string().trim().min(3).max(120),
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
        currentPassword: zPassword('Mật khẩu hiện tại'),
        newPassword: z
            .string()
            .min(8, 'Mật khẩu mới phải có ít nhất 8 ký tự')
            .max(72, 'Mật khẩu mới quá dài')
            .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Mật khẩu mới không được vượt quá 72 byte'),
        confirmPassword: z.string().min(1, 'Vui lòng xác nhận mật khẩu mới'),
    })
    .strict()
    .refine((data) => data.currentPassword !== data.newPassword, {
        message: 'Mật khẩu mới phải khác mật khẩu hiện tại',
        path: ['newPassword'],
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
        message: 'Mật khẩu xác nhận không khớp',
        path: ['confirmPassword'],
    });
