import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

const technicalPurchaseItemSchema = z.object({
    materialName: z.string().trim().min(1, { message: 'Ten vat tu khong duoc de trong' }),
    unit: z.string().trim().min(1, { message: 'Don vi tinh khong duoc de trong' }),
    quantityRequested: z.number().gt(0, { message: 'So luong phai lon hon 0' }),
    note: zOptionalString(),
    assetId: zObjectId('May lien quan').optional(),
    imageUrls: z.array(z.string().trim().url({ message: 'Link anh khong hop le' })).max(3).optional(),
});

export const createTechnicalPurchaseSchema = z.object({
    items: z.array(technicalPurchaseItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
    requesterName: zOptionalString(),
    department: zOptionalString(),
    note: zOptionalString(),
    requestDate: zOptionalString(),
});

export const updateTechnicalPurchaseSchema = z.object({
    items: z.array(technicalPurchaseItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }).optional(),
    requesterName: zOptionalString(),
    department: zOptionalString(),
    note: zOptionalString(),
    requestDate: zOptionalString(),
});

export const approveTechnicalPurchaseSchema = z.object({
    items: z
        .array(
            z.object({
                quantityApproved: z.number().gt(0, { message: 'So luong duyet phai lon hon 0' }),
            })
        )
        .optional(),
});

export const rejectTechnicalPurchaseSchema = z.object({
    reason: z.string().trim().min(1, { message: 'Ly do tu choi khong duoc de trong' }),
});
