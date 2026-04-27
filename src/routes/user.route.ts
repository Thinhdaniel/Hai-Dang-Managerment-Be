import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { userService } from '@/services';
import { createUserSchema, updateUserSchema } from '@/validations/user.validation';
import { USER_ROLE } from '@/constant/allowedRoles';

const router = Router();

router.use(authenticate);

router.get('/me', asyncHandler(userService.getMe));
router.post('/', authorize(USER_ROLE.ADMIN), validator(createUserSchema), asyncHandler(userService.createUser));
router.get('/', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), asyncHandler(userService.getAllUsers));
router.get(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    asyncHandler(userService.getUserById)
);
router.patch(
    '/:id',
    authorize(USER_ROLE.ADMIN),
    validateObjectId,
    validator(updateUserSchema),
    asyncHandler(userService.updateUser)
);
router.delete('/:id', authorize(USER_ROLE.ADMIN), validateObjectId, asyncHandler(userService.deleteUser));

export default router;
