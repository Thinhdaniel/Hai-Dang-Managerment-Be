import { Router } from 'express';
import { brandController } from '@/controllers';
import validator from '@/middlewares/validator';
import { createBrandSchema, updateBrandSchema } from '@/validations/brand.validation';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createBrandSchema),
    brandController.createBrand
);
router.get('/', brandController.getAllBrands);
router.get('/:id', validateObjectId, brandController.getBrandById);
router.put(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateBrandSchema),
    brandController.updateBrand
);
router.patch(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateBrandSchema),
    brandController.updateBrand
);
router.delete('/:id', authorize(...ROLE_GROUPS.ADMIN_ONLY), validateObjectId, brandController.deleteBrand);

export default router;
