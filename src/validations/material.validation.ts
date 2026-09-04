import { zObjectId, zOptionalString, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createMaterialSchema = z.object({
    name: zRequiredString('Ten vat tu'),
    code: zOptionalString(),
    category: zOptionalString(),
    unit: zRequiredString('Don vi tinh'),
    description: zOptionalString(),
    minStockLevel: z.number().min(0).optional(),
    trackInventory: z.boolean().optional(),
    reuseTrackingMode: z.enum(['none', 'quantity', 'serialized']).optional(),
    defaultReturnDays: z.number().int().min(0).max(3650).optional(),
    conditionCheckRequired: z.boolean().optional(),
    isActive: z.boolean().optional(),
});

export const updateMaterialSchema = z.object({
    name: zOptionalString(),
    code: zOptionalString(),
    category: zOptionalString(),
    unit: zOptionalString(),
    description: zOptionalString(),
    minStockLevel: z.number().min(0).optional(),
    trackInventory: z.boolean().optional(),
    reuseTrackingMode: z.enum(['none', 'quantity', 'serialized']).optional(),
    defaultReturnDays: z.number().int().min(0).max(3650).optional(),
    conditionCheckRequired: z.boolean().optional(),
    isActive: z.boolean().optional(),
});
