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
    coverageZoneId: zObjectId('Khu vuc coverage').optional(),
    coverageZoneName: zOptionalString(),
});

const stocktakeCoverageZoneSchema = z.object({
    zoneId: zObjectId('Khu vuc').optional(),
    name: z.string().trim().min(1).max(100),
    anchorCode: zOptionalString(),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    w: z.number().min(1).max(100).optional(),
    h: z.number().min(1).max(100).optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).default('pending'),
    activationSource: z.enum(['anchor', 'manual', 'auto']).optional(),
    expectedCount: z.number().int().nonnegative().default(0),
    scannedCount: z.number().int().nonnegative().default(0),
    startedAt: z.coerce.date().optional(),
    completedAt: z.coerce.date().optional(),
});

const stocktakePositionProposalSchema = z.object({
    assetId: zObjectId('May'),
    machineCode: zOptionalString(),
    name: zOptionalString(),
    zoneId: zObjectId('Khu vuc'),
    zoneName: z.string().trim().min(1).max(100),
    currentX: z.number().min(0).max(100).optional(),
    currentY: z.number().min(0).max(100).optional(),
    proposedX: z.number().min(0).max(100),
    proposedY: z.number().min(0).max(100),
    assetUpdatedAt: z.coerce.date(),
    scannedAt: z.coerce.date(),
    confidence: z.number().min(0).max(1),
    basis: z.literal('scan_order').default('scan_order'),
});

export const createStocktakeSessionSchema = z.object({
    plantId: zObjectId('Co so'),
    plantName: zOptionalString(),
    area: zOptionalString(),
    areaLabel: zOptionalString(),
    captureMode: z.enum(['single', 'sweep']).default('single'),
    scannerEngine: z.enum(['zxing', 'barcode_detector']).optional(),
    detectedCodeCount: z.number().int().nonnegative().default(0),
    duplicateScanCount: z.number().int().nonnegative().default(0),
    coveragePercent: z.number().min(0).max(100).default(0),
    coverageCompletedCount: z.number().int().nonnegative().default(0),
    coverageZones: z.array(stocktakeCoverageZoneSchema).max(100).default([]),
    positionProposals: z.array(stocktakePositionProposalSchema).max(2000).default([]),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date(),
    expectedCount: z.number().int().nonnegative(),
    scannedCount: z.number().int().nonnegative(),
    presentCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    anomalyCount: z.number().int().nonnegative(),
    items: z.array(stocktakeItemSchema).max(10000).default([]),
});

export const reviewStocktakePositionProposalsSchema = z.object({
    assetIds: z.array(zObjectId('May')).min(1).max(500),
    action: z.enum(['approve', 'reject']),
    note: zOptionalString(),
});

export const createStocktakeDriftProposalSchema = z.object({
    assetId: zObjectId('May'),
});
