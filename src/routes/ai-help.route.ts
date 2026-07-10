import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import validator from '@/middlewares/validator';
import {
    aiAssetAssistantSchema,
    aiAssetSearchSchema,
    aiChatSummarySchema,
    aiMaterialMatchSchema,
    aiTtsSchema,
    askAiHelpSchema,
} from '@/validations/ai-help.validation';
import { askAiHelp } from '@/services/ai-help.service';
import { aiAssetSearch } from '@/services/ai-asset-search.service';
import { askAssetAssistant } from '@/services/ai-asset-assistant.service';
import { askAgentAssistant, streamAgentAssistant } from '@/services/ai-agent.service';
import { synthesizeSpeech } from '@/services/ai-tts.service';
import { matchMaterialsByAi } from '@/services/ai-material-match.service';
import { summarizeChatConversation } from '@/services/ai-chat-summary.service';
import { scanMachineLabel, scanPurchaseInvoice, scanSupplyRequest } from '@/services/ai-ocr.service';
import { reviewPurchaseRequest } from '@/services/ai-approval-review.service';
import { runAnalyticsQuery, getAnalyticsCatalog } from '@/services/ai-analytics.service';
import {
    getIncidentReplayHistory,
    getIncidentReplayHistoryById,
    runIncidentReplay,
    submitIncidentReplayFeedback,
    updateIncidentReplayWorkflow,
} from '@/services/ai-incident-replay.service';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { getQrFieldInsight } from '@/services/ai-qr-field.service';
import { imageUpload } from '@/middlewares/multerMiddleware';

const router = Router();

router.use(authenticate);

router.post('/help', validator(askAiHelpSchema), asyncHandler(askAiHelp));
router.post('/asset-search', validator(aiAssetSearchSchema), asyncHandler(aiAssetSearch));
router.post('/assistant/assets', validator(aiAssetAssistantSchema), asyncHandler(askAssetAssistant));
router.post('/assistant', validator(aiAssetAssistantSchema), asyncHandler(askAgentAssistant));
router.post('/assistant/stream', validator(aiAssetAssistantSchema), asyncHandler(streamAgentAssistant));
router.post('/tts', validator(aiTtsSchema), asyncHandler(synthesizeSpeech));
router.post('/material-match', validator(aiMaterialMatchSchema), asyncHandler(matchMaterialsByAi));
router.post('/chat-summary', validator(aiChatSummarySchema), asyncHandler(summarizeChatConversation));
router.get('/qr-field/:assetId', asyncHandler(getQrFieldInsight));
router.post('/ocr/purchase-invoice', imageUpload.single('image'), asyncHandler(scanPurchaseInvoice));
router.post('/ocr/supply-request', imageUpload.single('image'), asyncHandler(scanSupplyRequest));
router.post('/ocr/machine-label', imageUpload.array('images', 3), asyncHandler(scanMachineLabel));
router.post('/purchase-request/:id/review', asyncHandler(reviewPurchaseRequest));
router.get('/analytics/catalog', asyncHandler(getAnalyticsCatalog));
router.post('/analytics/query', asyncHandler(runAnalyticsQuery));
router.get('/incident-replay/history', asyncHandler(getIncidentReplayHistory));
router.get('/incident-replay/history/:id', validateObjectId, asyncHandler(getIncidentReplayHistoryById));
router.post('/incident-replay/history/:id/feedback', validateObjectId, asyncHandler(submitIncidentReplayFeedback));
router.patch('/incident-replay/history/:id/workflow', validateObjectId, asyncHandler(updateIncidentReplayWorkflow));
router.post('/incident-replay', asyncHandler(runIncidentReplay));

export default router;
