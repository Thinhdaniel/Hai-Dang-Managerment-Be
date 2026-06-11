import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { userService } from '@/services';
import { createUserSchema, updateUserSchema } from '@/validations/user.validation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.get('/me', asyncHandler(userService.getMe));
router.post('/', authorize(...ROLE_GROUPS.ADMIN_ONLY), validator(createUserSchema), asyncHandler(userService.createUser));
router.get('/', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(userService.getAllUsers));
router.get(
    '/:id',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectId,
    asyncHandler(userService.getUserById)
);
router.patch(
    '/:id',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validateObjectId,
    validator(updateUserSchema),
    asyncHandler(userService.updateUser)
);
router.delete('/:id', authorize(...ROLE_GROUPS.ADMIN_ONLY), validateObjectId, asyncHandler(userService.deleteUser));

export default router;
