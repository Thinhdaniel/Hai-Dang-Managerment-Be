import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

// Toa do co so: cho phep null de xoa toa do da nhap
const zCoordinates = z
    .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
    })
    .nullable()
    .optional();

export const createPlantSchema = z.object({
    name: zRequiredString('Ten co so'),
    code: zRequiredString('Ma co so'),
    address: zOptionalString(),
    phone: zOptionalString(),
    managerId: zObjectId('Quan ly').optional(),
    coordinates: zCoordinates,
});

export const updatePlantSchema = z.object({
    name: zOptionalString(),
    code: zOptionalString(),
    address: zOptionalString(),
    phone: zOptionalString(),
    managerId: zObjectId('Quan ly').optional(),
    coordinates: zCoordinates,
});
