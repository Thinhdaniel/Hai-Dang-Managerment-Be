import { z } from 'zod';
import { zObjectId } from '@/lib/validation';

const helpContextTopicSchema = z.object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1200),
    category: z.string().trim().max(60).optional(),
    prerequisites: z.array(z.string().trim().min(1).max(700)).max(8).optional(),
    steps: z.array(z.string().trim().min(1).max(600)).max(12).default([]),
    checkpoints: z.array(z.string().trim().min(1).max(700)).max(8).optional(),
    commonMistakes: z.array(z.string().trim().min(1).max(700)).max(8).optional(),
    notes: z.array(z.string().trim().min(1).max(600)).max(8).optional(),
});

export const askAiHelpSchema = z.object({
    question: z.string().trim().min(2).max(1000),
    route: z.string().trim().max(200).optional(),
    contextTopics: z.array(helpContextTopicSchema).max(6).default([]),
});

export const aiAssetSearchSchema = z.object({
    query: z.string().trim().min(2).max(500),
});

export const aiAssetAssistantSchema = z.object({
    messages: z
        .array(
            z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string().trim().min(1).max(2000),
            })
        )
        .min(1, { message: 'Can it nhat 1 tin nhan' })
        .max(20),
});

export const aiTtsSchema = z.object({
    text: z.string().trim().min(1).max(4000),
    voice: z.string().trim().max(60).optional(),
    rate: z.string().trim().max(8).optional(),
    pitch: z.string().trim().max(8).optional(),
});

export const aiMaterialMatchSchema = z.object({
    items: z
        .array(
            z.object({
                key: z.string().trim().min(1).max(120),
                materialName: z.string().trim().min(1).max(300),
                unit: z.string().trim().max(80).optional(),
                note: z.string().trim().max(500).optional(),
            })
        )
        .min(1, { message: 'Phai co it nhat 1 dong vat tu can so khop' })
        .max(50, { message: 'Chi so khop toi da 50 dong moi lan' }),
});

export const aiChatSummarySchema = z.object({
    conversationId: zObjectId('Hoi thoai'),
    limit: z.number().int().min(10).max(120).optional(),
});
