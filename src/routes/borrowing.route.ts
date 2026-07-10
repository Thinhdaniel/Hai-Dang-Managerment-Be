import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { borrowingController } from '@/controllers';
import {
    bulkReturnBorrowingBatchSchema,
    createBorrowingBatchQrSchema,
    createBorrowingBatchSchema,
    createBorrowingSchema,
    receiveBorrowingBatchByQrSchema,
    receiveBorrowingBatchBulkSchema,
    returnBorrowingSchema,
    updateBorrowingBatchSchema,
} from '@/validations/borrowing.validation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.get('/batches', authorize(...ROLE_GROUPS.MANAGEMENT), borrowingController.getAllBorrowingBatches);
// Dat truoc '/batches/:id' de 'stats' khong bi validateObjectId chan
router.get('/batches/stats', authorize(...ROLE_GROUPS.MANAGEMENT), borrowingController.getBorrowingBatchStats);
router.get(
    '/batches/:id/export-xlsx',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    borrowingController.exportBorrowingBatchHandover
);
router.post(
    '/batches',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createBorrowingBatchSchema),
    borrowingController.createBorrowingBatch
);
router.get(
    '/batches/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    borrowingController.getBorrowingBatchById
);
router.patch(
    '/batches/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateBorrowingBatchSchema),
    borrowingController.updateBorrowingBatch
);
router.post(
    '/batches/:id/qr-batch',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(createBorrowingBatchQrSchema),
    borrowingController.createBorrowingBatchQr
);
router.post(
    '/batches/:id/receive-by-qr',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(receiveBorrowingBatchByQrSchema),
    borrowingController.receiveBorrowingBatchByQr
);
router.post(
    '/batches/:id/receive-bulk',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(receiveBorrowingBatchBulkSchema),
    borrowingController.receiveBorrowingBatchBulk
);
router.post(
    '/batches/:id/bulk-return',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(bulkReturnBorrowingBatchSchema),
    borrowingController.bulkReturnBorrowingBatch
);

router.post(
    '/',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createBorrowingSchema),
    borrowingController.createBorrowing
);
router.get('/', borrowingController.getAllBorrowings);
router.get('/asset/:assetId', validateObjectId, borrowingController.getBorrowingByAsset);
router.get('/:id', validateObjectId, borrowingController.getBorrowingById);
router.patch(
    '/:id/return',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(returnBorrowingSchema),
    borrowingController.returnBorrowing
);

export default router;
