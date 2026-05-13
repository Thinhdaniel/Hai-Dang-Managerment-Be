import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { transferController } from '@/controllers';
import { createTransferSchema, rejectTransferSchema, cancelTransferSchema, completeTransferSchema } from '@/validations/transfer.validation';
import { USER_ROLE } from '@/constant/allowedRoles';

const router = Router();

router.use(authenticate);

router.post('/', validator(createTransferSchema), transferController.createTransfer);
router.get('/', transferController.getAllTransfers);
router.get('/asset/:assetId', validateObjectId, transferController.getTransferByAsset);
router.get('/:id/export-stock-out-xlsx', validateObjectId, transferController.exportTransferStockOutXlsx);
router.get('/:id', validateObjectId, transferController.getTransferById);
router.patch(
    '/:id/approve',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    transferController.approveTransfer
);
router.patch(
    '/:id/reject',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(rejectTransferSchema),
    transferController.rejectTransfer
);
router.patch(
    '/:id/complete',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(completeTransferSchema),
    transferController.completeTransfer
);
router.patch(
    '/:id/cancel',
    validateObjectId,
    validator(cancelTransferSchema),
    transferController.cancelTransfer
);

export default router;
