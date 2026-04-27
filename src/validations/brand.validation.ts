import { zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createBrandSchema = z.object({
    name: zRequiredString('Ten nhan hieu'),
    description: zOptionalString(),
});

export const updateBrandSchema = z.object({
    name: zOptionalString(),
    description: zOptionalString(),
});
