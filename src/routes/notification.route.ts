import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { notificationService } from '@/services';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(notificationService.getNotifications));
router.patch('/read-all', asyncHandler(notificationService.markAllNotificationsAsRead));
router.patch('/:id/read', asyncHandler(notificationService.markNotificationAsRead));

export default router;
