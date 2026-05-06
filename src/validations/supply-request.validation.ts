import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

const supplyRequestItemSchema = z.object({
    materialName: z.string().trim().min(1, { message: 'Ten vat tu khong duoc de trong' }),
    unit: z.string().trim().min(1, { message: 'Don vi tinh khong duoc de trong' }),
    quantityRequested: z.number().gt(0, { message: 'So luong de xuat phai lon hon 0' }),
    note: zOptionalString(),
});

export const createSupplyRequestSchema = z.object({
    items: z.array(supplyRequestItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
    note: z.string().trim().min(10, { message: 'Ghi chu ly do de xuat la bat buoc, toi thieu 10 ky tu' }),
    requestDate: zOptionalString(),
});

export const updateSupplyRequestSchema = z.object({
    items: z.array(supplyRequestItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }).optional(),
    note: zOptionalString(),
    requestDate: zOptionalString(),
});

export const approveSupplyRequestSchema = z.object({
    items: z.array(z.object({
        materialId: zObjectId('Vat tu'),
        quantityApproved: z.number().gt(0, { message: 'So luong duyet phai lon hon 0' }),
    })).min(1, { message: 'Phai co it nhat 1 vat tu duoc duyet' }),
});

export const rejectSupplyRequestSchema = z.object({
    reason: z.string().trim().min(1, { message: 'Ly do tu choi khong duoc de trong' }),
});
