import { z } from 'zod';

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
