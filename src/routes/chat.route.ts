import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { chatAttachmentUpload } from '@/middlewares/multerMiddleware';
import * as chatService from '@/services/chat.service';

const router = Router();

router.use(authenticate);

router.get('/users', asyncHandler(chatService.getAvailableUsers));
router.get('/unread', asyncHandler(chatService.getUnreadSummary));
router.get('/mentions', asyncHandler(chatService.getMyMentions));
router.get('/context/:type/:id', asyncHandler(chatService.getContextConversation));
router.get('/conversations', asyncHandler(chatService.getConversations));
router.post('/conversations', asyncHandler(chatService.createConversation));
router.get('/conversations/:id/messages', validateObjectId, asyncHandler(chatService.getMessages));
router.get('/conversations/:id/messages/search', validateObjectId, asyncHandler(chatService.searchMessages));
router.get('/conversations/:id/pinned', validateObjectId, asyncHandler(chatService.getPinnedMessages));
router.post('/conversations/:id/messages', validateObjectId, asyncHandler(chatService.sendMessage));
router.post(
    '/conversations/:id/messages/:messageId/reactions',
    validateObjectId,
    asyncHandler(chatService.toggleReaction)
);
router.patch('/conversations/:id/messages/:messageId/pin', validateObjectId, asyncHandler(chatService.togglePin));
router.post(
    '/conversations/:id/attachments',
    validateObjectId,
    chatAttachmentUpload.fields([
        { name: 'images', maxCount: 4 },
        { name: 'audio', maxCount: 1 },
    ]),
    asyncHandler(chatService.sendAttachmentMessage)
);
router.patch('/conversations/:id/read', validateObjectId, asyncHandler(chatService.markConversationAsRead));
router.patch('/conversations/:id/mute', validateObjectId, asyncHandler(chatService.setConversationMuted));
router.delete('/conversations/:id/messages/:messageId', validateObjectId, asyncHandler(chatService.recallMessage));

export default router;
