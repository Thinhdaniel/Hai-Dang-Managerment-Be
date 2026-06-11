import { Router } from 'express';
import { qrScanLogController } from '@/controllers';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import { ROLE_GROUPS } from '@/constant/permissions';
import { createQrScanLogSchema } from '@/validations/qr-scan-log.validation';

const router = Router();

router.use(authenticate);

router.post('/', authorize(...ROLE_GROUPS.FIELD), validator(createQrScanLogSchema), qrScanLogController.createQrScanLog);
router.get('/', authorize(...ROLE_GROUPS.MANAGEMENT), qrScanLogController.getQrScanLogs);

export default router;
