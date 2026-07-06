import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { transferController } from '@/controllers';
import { createTransferSchema, rejectTransferSchema, cancelTransferSchema, completeTransferSchema } from '@/validations/transfer.validation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.post('/', authorize(...ROLE_GROUPS.MANAGEMENT), validator(createTransferSchema), transferController.createTransfer);
router.get('/', transferController.getAllTransfers);
router.get('/asset/:assetId', validateObjectId, transferController.getTransferByAsset);
router.get('/:id/export-stock-out-xlsx', validateObjectId, transferController.exportTransferStockOutXlsx);
router.get('/:id', validateObjectId, transferController.getTransferById);
router.patch(
    '/:id/approve',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    transferController.approveTransfer
);
router.patch(
    '/:id/reject',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(rejectTransferSchema),
    transferController.rejectTransfer
);
router.patch(
    '/:id/complete',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(completeTransferSchema),
    transferController.completeTransfer
);
// Hủy lệnh điều chuyển: chỉ Giám đốc trở lên (Super Admin + Giám đốc)
router.patch(
    '/:id/cancel',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectId,
    validator(cancelTransferSchema),
    transferController.cancelTransfer
);

export default router;
