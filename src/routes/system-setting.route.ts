import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { audioUpload } from '@/middlewares/multerMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as systemSettingService from '@/services/system-setting.service';

const router = Router();

router.use(authenticate);

router.get('/notification-sound', asyncHandler(systemSettingService.getNotificationSound));
router.put(
    '/notification-sound',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    audioUpload.single('sound'),
    asyncHandler(systemSettingService.uploadNotificationSound)
);
router.delete(
    '/notification-sound',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    asyncHandler(systemSettingService.deleteNotificationSound)
);

export default router;
