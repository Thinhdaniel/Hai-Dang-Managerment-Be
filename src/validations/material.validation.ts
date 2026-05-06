import { zObjectId, zOptionalString, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createMaterialSchema = z.object({
    name: zRequiredString('Ten vat tu'),
    code: zOptionalString(),
    category: zOptionalString(),
    unit: zRequiredString('Don vi tinh'),
    description: zOptionalString(),
    minStockLevel: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
});

export const updateMaterialSchema = z.object({
    name: zOptionalString(),
    code: zOptionalString(),
    category: zOptionalString(),
    unit: zOptionalString(),
    description: zOptionalString(),
    minStockLevel: z.number().min(0).optional(),
    isActive: z.boolean().optional(),
});
