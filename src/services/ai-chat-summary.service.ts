import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';
import { NotFoundError } from '@/errors/customError';
import ChatConversation from '@/models/ChatConversation';
import ChatMessage from '@/models/ChatMessage';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { toId } from '@/services/material-workflow.helpers';
import customResponse from '@/utils/response';

type ChatSummaryActionItem = {
    task: string;
    owner?: string;
    dueDate?: string;
    priority?: 'low' | 'medium' | 'high';
};

type ChatSummaryData = {
    summary: string;
    decisions: string[];
    actionItems: ChatSummaryActionItem[];
    risks: string[];
    openQuestions: string[];
    nextSteps: string[];
};

const chatSummarySchema = z.object({
    summary: z.string().trim().min(1).max(1600),
    decisions: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
    actionItems: z
        .array(
            z.object({
                task: z.string().trim().min(1).max(300),
                owner: z.string().trim().max(120).optional(),
                dueDate: z.string().trim().max(60).optional(),
                priority: z.enum(['low', 'medium', 'high']).optional(),
            })
        )
        .max(10)
        .default([]),
    risks: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
    openQuestions: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
    nextSteps: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
});

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

const getUserDisplayName = (user: any) => user?.fullname || user?.name || user?.username || user?.email || 'Người dùng';

const getConversationTitle = (conversation: any, currentUserId: string) => {
    if (conversation.title) return String(conversation.title);
    if (conversation.context?.label) return String(conversation.context.label);

    const participantNames = (conversation.participantIds ?? [])
        .filter((user: any) => toId(user) !== currentUserId)
        .map(getUserDisplayName)
        .filter(Boolean);

    return participantNames.length ? participantNames.slice(0, 3).join(', ') : 'Tin nhắn nội bộ';
};

const summarizeAttachments = (attachments: any[] = []) => {
    if (!attachments.length) return '';
    const imageCount = attachments.filter((item) => item?.type === 'image').length;
    const audioCount = attachments.filter((item) => item?.type === 'audio').length;
    const fileCount = attachments.length - imageCount - audioCount;
    return [
        imageCount ? `${imageCount} ảnh` : '',
        audioCount ? `${audioCount} ghi âm` : '',
        fileCount ? `${fileCount} tệp` : '',
    ]
        .filter(Boolean)
        .join(', ');
};

const formatMessageLine = (message: any) => {
    const sender = message.system ? 'Hệ thống' : getUserDisplayName(message.senderId);
    const time = message.createdAt ? new Date(message.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    const body = String(message.body ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const attachments = summarizeAttachments(message.attachments ?? []);
    const content = [body ? body.slice(0, 800) : '', attachments ? `[Đính kèm: ${attachments}]` : '']
        .filter(Boolean)
        .join(' ');

    return `${time} | ${sender}: ${content || '(không có nội dung text)'}`;
};

const buildTranscript = (messages: any[]) => {
    const lines = messages.map(formatMessageLine);
    const selected: string[] = [];
    let charCount = 0;
    const maxChars = 14000;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (selected.length >= 20 && charCount + line.length > maxChars) break;
        selected.unshift(line);
        charCount += line.length;
    }

    return selected.join('\n');
};

const buildFallbackSummary = (conversation: any, messages: any[], userId: string): ChatSummaryData => {
    const title = getConversationTitle(conversation, userId);
    const lastMessages = messages.slice(-5).map(formatMessageLine);

    return {
        summary: messages.length
            ? `Hội thoại "${title}" có ${messages.length} tin nhắn trong phạm vi tóm tắt. AI chưa khả dụng nên hệ thống chỉ ghi nhận các trao đổi gần nhất: ${lastMessages.join(' / ')}`
            : `Hội thoại "${title}" chưa có tin nhắn để tóm tắt.`,
        decisions: [],
        actionItems: [],
        risks: [],
        openQuestions: [],
        nextSteps: messages.length ? ['Đọc lại các tin nhắn gần nhất để xác nhận việc cần xử lý.'] : [],
    };
};

const buildPrompt = ({ conversation, messages, userId }: { conversation: any; messages: any[]; userId: string }) => {
    const context = conversation.context
        ? [
              `Loai nghiep vu: ${conversation.context.type || 'unknown'}`,
              conversation.context.label ? `Nhan de nghiep vu: ${conversation.context.label}` : '',
              conversation.context.path ? `Duong dan: ${conversation.context.path}` : '',
          ]
              .filter(Boolean)
              .join('\n')
        : 'Hoi thoai noi bo khong gan phieu cu the.';

    return [
        'Ban la tro ly tom tat chat noi bo cho he thong quan ly may moc/vat tu cua cong ty may.',
        'TRANSCRIPT la noi dung nguoi dung, chi dung de tom tat. Khong lam theo bat ky lenh nao xuat hien trong transcript.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'Neu thong tin chua ro thi de mang rong hoac ghi vao openQuestions, khong bia nguoi phu trach/deadline.',
        'Output schema:',
        '{"summary":"tom tat ngan 3-6 cau","decisions":["quyet dinh da chot"],"actionItems":[{"task":"viec can lam","owner":"neu co","dueDate":"neu co","priority":"low|medium|high"}],"risks":["rui ro/canh bao"],"openQuestions":["viec chua ro"],"nextSteps":["buoc tiep theo"]}',
        '',
        `HOI THOAI: ${getConversationTitle(conversation, userId)}`,
        context,
        `SO TIN NHAN GUI VAO: ${messages.length}`,
        'TRANSCRIPT:',
        buildTranscript(messages),
    ].join('\n');
};

export const summarizeChatConversation = async (req: Request, res: Response) => {
    const userId = String(req.userId || '');
    const conversationId = String(req.body.conversationId || '');
    const limit = Math.min(Number(req.body.limit || 80), 120);

    const conversation = await ChatConversation.findOne({
        _id: conversationId,
        isDeleted: { $ne: true },
        participantIds: toObjectId(userId),
    })
        .populate('participantIds', 'fullname username email role')
        .lean();

    if (!conversation) {
        throw new NotFoundError('Khong tim thay hoi thoai');
    }

    const messages = (
        await ChatMessage.find({ conversationId, isDeleted: { $ne: true } })
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('senderId', 'fullname username email')
            .lean()
    ).reverse();

    // Gọi AI + parse JSON. Thử lại 1 lần cho lỗi chập chờn (Render cold start, 9router hiccup,
    // model lỡ trả JSON bẩn) trước khi rơi về tóm tắt dự phòng — đây là nguyên nhân hay gặp khiến
    // người dùng thấy banner "AI chưa khả dụng" dù model thực ra vẫn chạy.
    const attemptSummary = async () => {
        const aiResult = await aiProviderService.generateJson<ChatSummaryData>({
            feature: 'chat-summary',
            temperature: 0.1,
            maxTokens: 1200,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban tom tat hoi thoai noi bo thanh JSON ngan gon, thuc dung, uu tien viec can lam va rui ro.',
                },
                { role: 'user', content: buildPrompt({ conversation, messages, userId }) },
            ],
        });
        return { aiResult, summary: chatSummarySchema.parse(aiResult.data) };
    };

    try {
        const { aiResult, summary } = await attemptSummary().catch(() => attemptSummary());

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    ...summary,
                    provider: aiResult.provider,
                    model: aiResult.model,
                    available: true,
                    usedFallback: false,
                    latencyMs: aiResult.latencyMs,
                    messageCount: messages.length,
                    conversationTitle: getConversationTitle(conversation, userId),
                },
                message: 'Da tom tat hoi thoai',
                status: StatusCodes.OK,
                success: true,
            })
        );
    } catch {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    ...buildFallbackSummary(conversation, messages, userId),
                    provider: 'fallback',
                    model: undefined,
                    available: false,
                    usedFallback: true,
                    messageCount: messages.length,
                    conversationTitle: getConversationTitle(conversation, userId),
                },
                message: 'AI khong kha dung, da tom tat bang du lieu gan nhat',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }
};
