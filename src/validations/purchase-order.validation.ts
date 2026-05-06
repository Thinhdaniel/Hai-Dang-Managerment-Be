import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

export const createPurchaseOrderSchema = z.object({
    purchaseRequestIds: z.array(zObjectId('Phieu de xuat')).min(1, { message: 'Phai chon it nhat 1 phieu de xuat' }),
    note: zOptionalString(),
});

const updateItemSchema = z.object({
    index: z.number().int().min(0),
    quantityOrdered: z.number().min(0).optional(),
    unitPrice: z.number().min(0).optional(),
    vatRate: z.number().min(0).max(100).optional(),
    supplierId: zObjectId('Nha cung cap').optional(),
    supplierName: zOptionalString(),
    note: zOptionalString(),
});

export const updatePurchaseOrderSchema = z.object({
    items: z.array(updateItemSchema).optional(),
    note: zOptionalString(),
});

export const receivePurchaseOrderSchema = z.object({
    receivedAt: zOptionalString(),
    note: zOptionalString(),
});
