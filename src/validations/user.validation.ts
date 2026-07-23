import { USER_ROLE } from '@/constant/allowedRoles';
import { zObjectId, zOptionalString, zPassword, zRequiredEmail, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

// Tổ trưởng bị khóa theo cơ sở và không tự đổi được nên bắt buộc có plantId;
// thiếu cơ sở thì tài khoản không nhập được sản lượng cho đúng chuyền.
const requireLineLeaderPlant = (
    data: { role?: USER_ROLE; plantId?: string },
    ctx: z.RefinementCtx
) => {
    if (data.role === USER_ROLE.LINE_LEADER && !data.plantId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['plantId'],
            message: 'To truong phai duoc gan co so',
        });
    }
};

export const createUserSchema = z
    .object({
        name: zRequiredString('Ten nguoi dung'),
        email: zRequiredEmail(),
        password: zPassword(),
        phone: zOptionalString(),
        role: z.nativeEnum(USER_ROLE).optional(),
        plantId: zObjectId('Co so').optional(),
        avatarUrl: zOptionalString(),
        isActive: z.boolean().optional(),
    })
    .superRefine(requireLineLeaderPlant);

export const updateUserSchema = z
    .object({
        name: zOptionalString(),
        email: zRequiredEmail().optional(),
        phone: zOptionalString(),
        role: z.nativeEnum(USER_ROLE).optional(),
        plantId: zObjectId('Co so').optional(),
        avatarUrl: zOptionalString(),
        isActive: z.boolean().optional(),
    })
    .superRefine(requireLineLeaderPlant);
