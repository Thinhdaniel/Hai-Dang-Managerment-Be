import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { ROLE_GROUPS } from '@/constant/permissions';
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
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createMaterialSupplierSchema),
    materialSupplierController.createMaterialSupplier
);
router.put(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateMaterialSupplierSchema),
    materialSupplierController.updateMaterialSupplier
);

export default router;
