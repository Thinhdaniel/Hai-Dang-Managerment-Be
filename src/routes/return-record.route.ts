import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as ctrl from '@/controllers/return-record.controller';

const router = Router();
router.use(authenticate);

router.post('/', authorize(...ROLE_GROUPS.MANAGEMENT), ctrl.createReturnRecord);
router.get('/', authorize(...ROLE_GROUPS.MANAGEMENT), ctrl.getAllReturnRecords);
router.get('/by-po/:purchaseOrderId', authorize(...ROLE_GROUPS.MANAGEMENT), ctrl.getReturnsByPurchaseOrder);

export default router;
