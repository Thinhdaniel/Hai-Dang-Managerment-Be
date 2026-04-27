import { Router } from 'express';
import { brandController } from '@/controllers';
import validator from '@/middlewares/validator';
import { createBrandSchema, updateBrandSchema } from '@/validations/brand.validation';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { USER_ROLE } from '@/constant/allowedRoles';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(createBrandSchema),
    brandController.createBrand
);
router.get('/', brandController.getAllBrands);
router.get('/:id', validateObjectId, brandController.getBrandById);
router.put(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(updateBrandSchema),
    brandController.updateBrand
);
router.patch(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(updateBrandSchema),
    brandController.updateBrand
);
router.delete('/:id', authorize(USER_ROLE.ADMIN), validateObjectId, brandController.deleteBrand);

export default router;
