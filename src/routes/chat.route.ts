import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { chatImageUpload } from '@/middlewares/multerMiddleware';
import * as chatService from '@/services/chat.service';

const router = Router();

router.use(authenticate);

router.get('/users', asyncHandler(chatService.getAvailableUsers));
router.get('/unread', asyncHandler(chatService.getUnreadSummary));
router.get('/context/:type/:id', asyncHandler(chatService.getContextConversation));
router.get('/conversations', asyncHandler(chatService.getConversations));
router.post('/conversations', asyncHandler(chatService.createConversation));
router.get('/conversations/:id/messages', validateObjectId, asyncHandler(chatService.getMessages));
router.post('/conversations/:id/messages', validateObjectId, asyncHandler(chatService.sendMessage));
router.post(
    '/conversations/:id/attachments',
    validateObjectId,
    chatImageUpload.array('images', 4),
    asyncHandler(chatService.sendAttachmentMessage)
);
router.patch('/conversations/:id/read', validateObjectId, asyncHandler(chatService.markConversationAsRead));
router.patch('/conversations/:id/mute', validateObjectId, asyncHandler(chatService.setConversationMuted));
router.delete(
    '/conversations/:id/messages/:messageId',
    validateObjectId,
    asyncHandler(chatService.recallMessage)
);

export default router;
