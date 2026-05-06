import { zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const supplyTypeSchema = z.enum(['machine', 'material']);

export const createMaterialSupplierSchema = z.object({
    name: zRequiredString('Ten nha cung cap'),
    code: zOptionalString(),
    contactName: zOptionalString(),
    phone: zOptionalString(),
    address: zOptionalString(),
    supplyTypes: z.array(supplyTypeSchema).optional(),
    isActive: z.boolean().optional(),
});

export const updateMaterialSupplierSchema = z.object({
    name: zOptionalString(),
    code: zOptionalString(),
    contactName: zOptionalString(),
    phone: zOptionalString(),
    address: zOptionalString(),
    supplyTypes: z.array(supplyTypeSchema).optional(),
    isActive: z.boolean().optional(),
});
