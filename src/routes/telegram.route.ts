import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import * as telegramService from '@/services/telegram.service';

const router = Router();

router.post('/webhook', asyncHandler(telegramService.handleTelegramWebhook));

router.use(authenticate);

router.get('/status', asyncHandler(telegramService.getTelegramStatus));
router.post('/link', asyncHandler(telegramService.createTelegramLink));
router.delete('/link', asyncHandler(telegramService.unlinkTelegram));

export default router;
