import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { USER_ROLE } from '@/constant/allowedRoles';
import * as materialSupplierController from '@/controllers/material-supplier.controller';
import {
    createMaterialSupplierSchema,
    updateMaterialSupplierSchema,
} from '@/validations/material-supplier.validation';

const router = Router();

router.use(authenticate);

router.get('/', materialSupplierController.getAllMaterialSuppliers);
router.post(
    '/',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(createMaterialSupplierSchema),
    materialSupplierController.createMaterialSupplier
);
router.put(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(updateMaterialSupplierSchema),
    materialSupplierController.updateMaterialSupplier
);

export default router;
