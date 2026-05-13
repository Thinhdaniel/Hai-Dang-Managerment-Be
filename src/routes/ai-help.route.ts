import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import validator from '@/middlewares/validator';
import { askAiHelpSchema } from '@/validations/ai-help.validation';
import { askAiHelp } from '@/services/ai-help.service';

const router = Router();

router.use(authenticate);

router.post('/help', validator(askAiHelpSchema), asyncHandler(askAiHelp));

export default router;

