import { Router } from 'express';
import { qrLabelController } from '@/controllers';
import { USER_ROLE } from '@/constant/allowedRoles';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import {
    activateMachineQrLabelSchema,
    createQrLabelBatchSchema,
    createQrLabelSchema,
    linkAssetQrLabelSchema,
    retireQrLabelSchema,
} from '@/validations/qr-label.validation';

const router = Router();

router.use(authenticate);

router.get('/batches', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), qrLabelController.getBatches);
router.post(
    '/batches',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(createQrLabelBatchSchema),
    qrLabelController.createBatch
);
router.get(
    '/batches/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    qrLabelController.getBatchById
);
router.post(
    '/batches/:id/mark-printed',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    qrLabelController.markBatchPrinted
);

router.get('/resolve/:publicId', qrLabelController.resolveInternalQr);

router.get('/', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), qrLabelController.getLabels);
router.post(
    '/',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(createQrLabelSchema),
    qrLabelController.createLabel
);
router.post(
    '/:publicId/activate-machine',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(activateMachineQrLabelSchema),
    qrLabelController.activateMachineLabel
);
router.post(
    '/:publicId/link-asset',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(linkAssetQrLabelSchema),
    qrLabelController.linkAssetLabel
);
router.patch(
    '/:id/retire',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(retireQrLabelSchema),
    qrLabelController.retireLabel
);

export default router;
