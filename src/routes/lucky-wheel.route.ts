import { Router } from 'express';
import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import * as luckyWheelService from '@/services/lucky-wheel.service';
import asyncHandler from '@/utils/asyncHandler';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.DIRECTOR_UP));

router.get('/', asyncHandler(luckyWheelService.listLuckyWheelEvents));
router.post('/', asyncHandler(luckyWheelService.createLuckyWheelEvent));
router.get('/:id', asyncHandler(luckyWheelService.getLuckyWheelEvent));
router.patch('/:id', asyncHandler(luckyWheelService.updateLuckyWheelEvent));
router.post('/:id/spin', asyncHandler(luckyWheelService.spinLuckyWheelEvent));
router.post('/:id/reset', asyncHandler(luckyWheelService.resetLuckyWheelWinners));
router.delete('/:id', asyncHandler(luckyWheelService.deleteLuckyWheelEvent));

export default router;
