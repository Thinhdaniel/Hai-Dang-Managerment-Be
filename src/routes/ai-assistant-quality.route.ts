import { Router } from 'express';
import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import asyncHandler from '@/utils/asyncHandler';
import {
    getAssistantQualityOverview,
    getAssistantTraceDetail,
    listAssistantTraces,
    replayAssistantTrace,
} from '@/services/ai-assistant-quality.service';
import { assistantReplaySchema } from '@/validations/ai-assistant-quality.validation';
import { userRateLimitMiddleware } from '@/middlewares/limiterResquestMiddleware';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.ADMIN_ONLY));

router.get('/overview', asyncHandler(getAssistantQualityOverview));
router.get('/traces', asyncHandler(listAssistantTraces));
router.get('/traces/:reqId', asyncHandler(getAssistantTraceDetail));
router.post(
    '/traces/:reqId/replay',
    userRateLimitMiddleware(60, 5),
    validator(assistantReplaySchema),
    asyncHandler(replayAssistantTrace)
);

export default router;
