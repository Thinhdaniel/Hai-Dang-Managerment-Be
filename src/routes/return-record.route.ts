import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { USER_ROLE } from '@/constant/allowedRoles';
import * as ctrl from '@/controllers/return-record.controller';

const router = Router();
router.use(authenticate);

router.post('/', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), ctrl.createReturnRecord);
router.get('/', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), ctrl.getAllReturnRecords);
router.get('/by-po/:purchaseOrderId', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), ctrl.getReturnsByPurchaseOrder);

export default router;
