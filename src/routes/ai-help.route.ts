import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import validator from '@/middlewares/validator';
import { aiAssetSearchSchema, askAiHelpSchema } from '@/validations/ai-help.validation';
import { askAiHelp } from '@/services/ai-help.service';
import { aiAssetSearch } from '@/services/ai-asset-search.service';

const router = Router();

router.use(authenticate);

router.post('/help', validator(askAiHelpSchema), asyncHandler(askAiHelp));
router.post('/asset-search', validator(aiAssetSearchSchema), asyncHandler(aiAssetSearch));

export default router;

