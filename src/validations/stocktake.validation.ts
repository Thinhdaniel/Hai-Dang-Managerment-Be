import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

const stocktakeItemSchema = z.object({
    type: z.enum(['missing', 'present', 'wrong_area', 'wrong_plant', 'unknown']),
    assetId: zObjectId('Thiet bi').optional(),
    rawValue: zOptionalString(),
    machineCode: zOptionalString(),
    name: zOptionalString(),
    plantName: zOptionalString(),
    area: zOptionalString(),
    status: zOptionalString(),
    message: zOptionalString(),
    gpsNote: zOptionalString(),
    scannedAt: z.coerce.date().optional(),
});

export const createStocktakeSessionSchema = z.object({
    plantId: zObjectId('Co so'),
    plantName: zOptionalString(),
    area: zOptionalString(),
    areaLabel: zOptionalString(),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date(),
    expectedCount: z.number().int().nonnegative(),
    scannedCount: z.number().int().nonnegative(),
    presentCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    anomalyCount: z.number().int().nonnegative(),
    items: z.array(stocktakeItemSchema).max(10000).default([]),
});
