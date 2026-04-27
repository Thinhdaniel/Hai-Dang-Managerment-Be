import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createPlantSchema = z.object({
    name: zRequiredString('Ten co so'),
    code: zRequiredString('Ma co so'),
    address: zOptionalString(),
    phone: zOptionalString(),
    managerId: zObjectId('Quan ly').optional(),
});

export const updatePlantSchema = z.object({
    name: zOptionalString(),
    code: zOptionalString(),
    address: zOptionalString(),
    phone: zOptionalString(),
    managerId: zObjectId('Quan ly').optional(),
});
