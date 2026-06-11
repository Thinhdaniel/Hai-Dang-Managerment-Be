import { Router } from 'express';
import { qrScanLogController } from '@/controllers';
import { USER_ROLE } from '@/constant/allowedRoles';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import { createQrScanLogSchema } from '@/validations/qr-scan-log.validation';

const router = Router();

router.use(authenticate);

router.post('/', validator(createQrScanLogSchema), qrScanLogController.createQrScanLog);
router.get('/', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), qrScanLogController.getQrScanLogs);

export default router;
