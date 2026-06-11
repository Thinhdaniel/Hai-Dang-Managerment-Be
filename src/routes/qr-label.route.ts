import { Router } from 'express';
import { qrLabelController } from '@/controllers';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { ROLE_GROUPS } from '@/constant/permissions';
import {
    activateMachineQrLabelSchema,
    createQrLabelBatchSchema,
    createQrLabelSchema,
    linkAssetQrLabelSchema,
    retireQrLabelSchema,
} from '@/validations/qr-label.validation';

const router = Router();

router.use(authenticate);

router.get('/batches', authorize(...ROLE_GROUPS.ADMIN_ONLY), qrLabelController.getBatches);
router.post(
    '/batches',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validator(createQrLabelBatchSchema),
    qrLabelController.createBatch
);
router.get(
    '/batches/:id',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validateObjectId,
    qrLabelController.getBatchById
);
router.post(
    '/batches/:id/mark-printed',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validateObjectId,
    qrLabelController.markBatchPrinted
);

router.get('/resolve/:publicId', qrLabelController.resolveInternalQr);

router.get('/', authorize(...ROLE_GROUPS.ADMIN_ONLY), qrLabelController.getLabels);
router.post(
    '/',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validator(createQrLabelSchema),
    qrLabelController.createLabel
);
router.post(
    '/:publicId/activate-machine',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validator(activateMachineQrLabelSchema),
    qrLabelController.activateMachineLabel
);
router.post(
    '/:publicId/link-asset',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validator(linkAssetQrLabelSchema),
    qrLabelController.linkAssetLabel
);
router.patch(
    '/:id/retire',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validateObjectId,
    validator(retireQrLabelSchema),
    qrLabelController.retireLabel
);

export default router;
