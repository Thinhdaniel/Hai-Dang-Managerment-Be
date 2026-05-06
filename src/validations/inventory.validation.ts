import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

export const adjustInventorySchema = z.object({
    materialId: zObjectId('Vat tu'),
    plantId: zObjectId('Co so'),
    quantity: z.number().refine((value) => value !== 0, {
        message: 'So luong dieu chinh phai khac 0',
    }),
    note: zOptionalString(),
});

/** PUT /inventory/adjust — ghi đè tuyệt đối về newStock */
export const overrideInventorySchema = z.object({
    materialId: zObjectId('Vat tu'),
    plantId: zObjectId('Co so'),
    newStock: z.number().min(0, { message: 'Ton kho moi phai >= 0' }),
    reason: z.string().trim().min(1, { message: 'Ly do dieu chinh khong duoc de trong' }),
});

