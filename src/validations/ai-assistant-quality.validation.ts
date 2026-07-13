import { z } from 'zod';

export const assistantFeedbackSchema = z
    .object({
        rating: z.enum(['helpful', 'not_helpful']),
        reason: z.enum(['incorrect', 'misunderstood', 'missing_data', 'too_slow', 'too_verbose', 'other']).optional(),
        note: z.string().trim().max(1000).optional(),
    })
    .refine((value) => value.rating === 'helpful' || Boolean(value.reason), {
        message: 'Cần chọn nguyên nhân khi câu trả lời chưa hữu ích',
        path: ['reason'],
    });

export const assistantReplaySchema = z.object({
    model: z.string().trim().min(1).max(180).optional(),
});
