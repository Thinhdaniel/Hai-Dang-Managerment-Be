import { Router } from 'express';
import { authenticate, requireProcurementManager, requireProcurementDirector } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as purchaseRequestController from '@/controllers/purchase-request.controller';
import {
    approvePurchaseRequestSchema,
    consolidatePurchaseRequestsSchema,
    createPurchaseRequestSchema,
    rejectPurchaseRequestSchema,
    updatePurchaseRequestSchema,
} from '@/validations/purchase-request.validation';

const router = Router();

router.use(authenticate, requireProcurementManager);

// ── Static routes first ───────────────────────────────────────────────────
router.get('/pending', purchaseRequestController.getPendingPurchaseRequests);
router.post('/consolidate', validator(consolidatePurchaseRequestsSchema), purchaseRequestController.consolidatePurchaseRequests);
router.get('/', purchaseRequestController.getAllPurchaseRequests);
router.post('/', validator(createPurchaseRequestSchema), purchaseRequestController.createPurchaseRequest);

// ── Sub-resource routes before /:id ──────────────────────────────────────
router.get('/:id/export-xlsx', validateObjectId, purchaseRequestController.exportPurchaseRequestXlsx);
router.patch('/:id/approve', requireProcurementDirector, validateObjectId, validator(approvePurchaseRequestSchema), purchaseRequestController.approvePurchaseRequest);
router.patch('/:id/reject', requireProcurementDirector, validateObjectId, validator(rejectPurchaseRequestSchema), purchaseRequestController.rejectPurchaseRequest);

// ── Dynamic /:id routes last ──────────────────────────────────────────────
router.get('/:id', validateObjectId, purchaseRequestController.getPurchaseRequestById);
router.put('/:id', validateObjectId, validator(updatePurchaseRequestSchema), purchaseRequestController.updatePurchaseRequest);
router.patch('/:id', validateObjectId, validator(updatePurchaseRequestSchema), purchaseRequestController.updatePurchaseRequest);
router.delete('/:id', validateObjectId, purchaseRequestController.deletePurchaseRequest);

export default router;
