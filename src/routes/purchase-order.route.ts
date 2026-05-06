import { Router } from 'express';
import { authenticate, requireCS1Manager, requireCS1Director } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as ctrl from '@/controllers/purchase-order.controller';
import {
    createPurchaseOrderSchema,
    updatePurchaseOrderSchema,
} from '@/validations/purchase-order.validation';

const router = Router();

router.use(authenticate, requireCS1Manager);

router.get('/', ctrl.getAllPurchaseOrders);
router.post('/', validator(createPurchaseOrderSchema), ctrl.createPurchaseOrder);
router.get('/:id/export-xlsx', validateObjectId, ctrl.exportPurchaseOrderXlsx);
router.patch('/:id/confirm', requireCS1Director, validateObjectId, ctrl.confirmPurchaseOrder);
router.patch('/:id/receive', requireCS1Director, validateObjectId, ctrl.receivePurchaseOrder);
router.get('/:id', validateObjectId, ctrl.getPurchaseOrderById);
router.put('/:id', validateObjectId, validator(updatePurchaseOrderSchema), ctrl.updatePurchaseOrder);
router.delete('/:id', validateObjectId, ctrl.deletePurchaseOrder);

export default router;
