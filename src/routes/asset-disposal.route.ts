import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { assetDisposalService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import {
    approveAssetDisposalBatchSchema,
    cancelAssetDisposalBatchSchema,
    createAssetDisposalBatchSchema,
    createAssetDisposalItemSchema,
    scanAssetDisposalQrSchema,
    submitAssetDisposalBatchSchema,
    updateAssetDisposalBatchSchema,
    updateAssetDisposalItemSchema,
} from '@/validations/asset-disposal.validation';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.MANAGEMENT));

router.get('/batches', asyncHandler(assetDisposalService.getAllDisposalBatches));
router.post(
    '/batches',
    validator(createAssetDisposalBatchSchema),
    asyncHandler(assetDisposalService.createDisposalBatch)
);
router.get('/batches/:id', validateObjectId, asyncHandler(assetDisposalService.getDisposalBatchById));
router.patch(
    '/batches/:id',
    validateObjectId,
    validator(updateAssetDisposalBatchSchema),
    asyncHandler(assetDisposalService.updateDisposalBatch)
);
router.post(
    '/batches/:id/items',
    validateObjectId,
    validator(createAssetDisposalItemSchema),
    asyncHandler(assetDisposalService.addDisposalItem)
);
router.post(
    '/batches/:id/scan',
    validateObjectId,
    validator(scanAssetDisposalQrSchema),
    asyncHandler(assetDisposalService.scanDisposalQr)
);
router.post(
    '/batches/:id/submit',
    validateObjectId,
    validator(submitAssetDisposalBatchSchema),
    asyncHandler(assetDisposalService.submitDisposalBatch)
);
router.post(
    '/batches/:id/approve',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectId,
    validator(approveAssetDisposalBatchSchema),
    asyncHandler(assetDisposalService.approveDisposalBatch)
);
router.post(
    '/batches/:id/complete',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectId,
    asyncHandler(assetDisposalService.completeDisposalBatch)
);
router.post(
    '/batches/:id/cancel',
    validateObjectId,
    validator(cancelAssetDisposalBatchSchema),
    asyncHandler(assetDisposalService.cancelDisposalBatch)
);
router.get('/batches/:id/export-xlsx', validateObjectId, asyncHandler(assetDisposalService.exportDisposalBatchXlsx));
router.patch(
    '/items/:itemId',
    validateObjectId,
    validator(updateAssetDisposalItemSchema),
    asyncHandler(assetDisposalService.updateDisposalItem)
);

export default router;
