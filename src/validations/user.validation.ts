import { USER_ROLE } from '@/constant/allowedRoles';
import { zObjectId, zOptionalString, zPassword, zRequiredEmail, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createUserSchema = z.object({
    name: zRequiredString('Ten nguoi dung'),
    email: zRequiredEmail(),
    password: zPassword(),
    phone: zOptionalString(),
    role: z.nativeEnum(USER_ROLE).optional(),
    plantId: zObjectId('Co so').optional(),
    avatarUrl: zOptionalString(),
    isActive: z.boolean().optional(),
});

export const updateUserSchema = z.object({
    name: zOptionalString(),
    email: zRequiredEmail().optional(),
    phone: zOptionalString(),
    role: z.nativeEnum(USER_ROLE).optional(),
    plantId: zObjectId('Co so').optional(),
    avatarUrl: zOptionalString(),
    isActive: z.boolean().optional(),
});
