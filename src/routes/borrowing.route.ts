import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { borrowingController } from '@/controllers';
import { createBorrowingSchema, returnBorrowingSchema } from '@/validations/borrowing.validation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.post('/', authorize(...ROLE_GROUPS.MANAGEMENT), validator(createBorrowingSchema), borrowingController.createBorrowing);
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
