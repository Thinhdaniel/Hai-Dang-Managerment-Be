import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { userService } from '@/services';
import { createUserSchema, updateUserSchema } from '@/validations/user.validation';
import { ROLE_GROUPS } from '@/constant/permissions';
import { avatarUpload } from '@/middlewares/multerMiddleware';
import { updateMyAvatar, removeMyAvatar } from '@/services/user-avatar.service';
import rateLimit from 'express-rate-limit';
import { TooManyRequestsError } from '@/errors/customError';

const router = Router();

router.use(authenticate);

router.get('/me', asyncHandler(userService.getMe));
const avatarLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyGenerator: (req) => req.userId!,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) =>
        next(new TooManyRequestsError('Ban da doi anh qua nhieu lan. Vui long thu lai sau.')),
});
router.put('/me/avatar', avatarLimiter, avatarUpload, asyncHandler(updateMyAvatar));
router.delete('/me/avatar', avatarLimiter, asyncHandler(removeMyAvatar));
router.post(
    '/',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validator(createUserSchema),
    asyncHandler(userService.createUser)
);
router.get('/', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(userService.getAllUsers));
router.get('/:id', authorize(...ROLE_GROUPS.DIRECTOR_UP), validateObjectId, asyncHandler(userService.getUserById));
router.patch(
    '/:id',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validateObjectId,
    validator(updateUserSchema),
    asyncHandler(userService.updateUser)
);
router.delete('/:id', authorize(...ROLE_GROUPS.ADMIN_ONLY), validateObjectId, asyncHandler(userService.deleteUser));

export default router;
