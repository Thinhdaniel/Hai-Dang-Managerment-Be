import { Router } from 'express';
import { authenticate, requireProcurementManager } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as ctrl from '@/controllers/purchase-order.controller';
import {
    createPurchaseOrderSchema,
    createPurchaseOrderItemMaterialSchema,
    ignorePurchaseOrderItemInventorySchema,
    linkPurchaseOrderItemMaterialSchema,
    receivePurchaseOrderSchema,
    updatePurchaseOrderSchema,
} from '@/validations/purchase-order.validation';

const router = Router();

router.use(authenticate, requireProcurementManager);

router.get('/', ctrl.getAllPurchaseOrders);
router.get('/shortages', ctrl.getOutstandingPurchaseShortages);
router.post('/', validator(createPurchaseOrderSchema), ctrl.createPurchaseOrder);
router.get('/:id/export-xlsx', validateObjectId, ctrl.exportPurchaseOrderXlsx);
router.patch('/:id/confirm', validateObjectId, ctrl.confirmPurchaseOrder);
router.patch('/:id/receive', validateObjectId, validator(receivePurchaseOrderSchema), ctrl.receivePurchaseOrder);
router.patch('/:id/items/:index/link-material', validator(linkPurchaseOrderItemMaterialSchema), ctrl.linkPurchaseOrderItemMaterial);
router.post('/:id/items/:index/create-material', validator(createPurchaseOrderItemMaterialSchema), ctrl.createMaterialForPurchaseOrderItem);
router.patch('/:id/items/:index/ignore-inventory', validator(ignorePurchaseOrderItemInventorySchema), ctrl.ignorePurchaseOrderItemInventory);
router.get('/:id', validateObjectId, ctrl.getPurchaseOrderById);
router.put('/:id', validateObjectId, validator(updatePurchaseOrderSchema), ctrl.updatePurchaseOrder);
router.delete('/:id', validateObjectId, ctrl.deletePurchaseOrder);

export default router;
