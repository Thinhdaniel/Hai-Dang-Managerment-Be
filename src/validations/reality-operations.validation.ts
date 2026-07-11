import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

export const updateRealityAlertRuleSchema = z.object({
    plantId: zObjectId('Co so'),
    enabled: z.boolean().optional(),
    staleDays: z.number().int().min(7).max(180).optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    driftThreshold: z.number().int().min(1).max(1000).optional(),
    stalePercentThreshold: z.number().int().min(1).max(100).optional(),
    coverageOverdueDays: z.number().int().min(1).max(365).optional(),
    proposalOverdueDays: z.number().int().min(1).max(90).optional(),
    cooldownHours: z.number().int().min(1).max(168).optional(),
    defaultAssignee: zObjectId('Nguoi phu trach').nullable().optional(),
});

export const updateRealityOperationalAlertSchema = z.object({
    status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']).optional(),
    assignedTo: zObjectId('Nguoi phu trach').nullable().optional(),
    dueAt: z.coerce.date().nullable().optional(),
    resolutionNote: zOptionalString(),
});

export const evaluateRealityOperationsSchema = z.object({
    plantId: zObjectId('Co so'),
});
