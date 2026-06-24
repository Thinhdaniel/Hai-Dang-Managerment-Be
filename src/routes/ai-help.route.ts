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

export default router;
