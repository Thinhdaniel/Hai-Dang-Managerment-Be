import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { notificationService, webPushService } from '@/services';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(notificationService.getNotifications));
router.get('/push/public-key', asyncHandler(webPushService.getPublicKey));
router.get('/push/status', asyncHandler(webPushService.getStatus));
router.post('/push/subscribe', asyncHandler(webPushService.subscribe));
router.post('/push/unsubscribe', asyncHandler(webPushService.unsubscribe));
router.post('/push/test', asyncHandler(webPushService.sendTestNotification));
router.patch('/read-all', asyncHandler(notificationService.markAllNotificationsAsRead));
router.patch('/:id/read', asyncHandler(notificationService.markNotificationAsRead));
router.delete('/', asyncHandler(notificationService.deleteAllNotifications));
router.delete('/:id', validateObjectId, asyncHandler(notificationService.deleteNotification));

export default router;
