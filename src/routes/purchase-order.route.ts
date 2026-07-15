import { Router } from 'express';
import {
    authenticate,
    requireProcurementDirector,
    requireProcurementManager,
} from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { imageUpload } from '@/middlewares/multerMiddleware';
import * as ctrl from '@/controllers/purchase-order.controller';
import {
    cancelPurchaseOrderItemSchema,
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
router.get('/export-range-xlsx', ctrl.exportRangePurchaseOrdersXlsx);
router.post('/', validator(createPurchaseOrderSchema), ctrl.createPurchaseOrder);
router.get('/:id/export-xlsx', validateObjectId, ctrl.exportPurchaseOrderXlsx);
router.get('/:id/receipt-scans', validateObjectId, ctrl.getPurchaseReceiptScans);
router.patch('/:id/confirm', requireProcurementDirector, validateObjectId, ctrl.confirmPurchaseOrder);
router.post(
    '/:id/receipt-scan/preview',
    requireProcurementDirector,
    validateObjectId,
    imageUpload.array('images', 5),
    ctrl.previewPurchaseReceiptScan
);
// Học map tên hàng NCC -> vật tư nội bộ từ lần đối soát tay (gọi khi Áp dụng vào form)
router.post('/:id/receipt-scan/mappings', requireProcurementDirector, validateObjectId, ctrl.recordReceiptScanMappings);
router.patch(
    '/:id/receive',
    requireProcurementDirector,
    validateObjectId,
    validator(receivePurchaseOrderSchema),
    ctrl.receivePurchaseOrder
);
router.patch(
    '/:id/items/:index/link-material',
    validator(linkPurchaseOrderItemMaterialSchema),
    ctrl.linkPurchaseOrderItemMaterial
);
router.post(
    '/:id/items/:index/create-material',
    validator(createPurchaseOrderItemMaterialSchema),
    ctrl.createMaterialForPurchaseOrderItem
);
router.patch(
    '/:id/items/:index/ignore-inventory',
    validator(ignorePurchaseOrderItemInventorySchema),
    ctrl.ignorePurchaseOrderItemInventory
);
router.patch(
    '/:id/items/:index/cancel',
    requireProcurementDirector,
    validateObjectId,
    validator(cancelPurchaseOrderItemSchema),
    ctrl.cancelPurchaseOrderItem
);
router.get('/:id', validateObjectId, ctrl.getPurchaseOrderById);
router.put('/:id', validateObjectId, validator(updatePurchaseOrderSchema), ctrl.updatePurchaseOrder);
router.delete('/:id', validateObjectId, ctrl.deletePurchaseOrder);

export default router;
