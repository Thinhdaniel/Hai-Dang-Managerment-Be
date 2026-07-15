import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
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

export const cancelPurchaseOrderItemSchema = z.object({
    reason: zRequiredString('Ly do huy').max(500, { message: 'Ly do huy toi da 500 ky tu' }),
});

export const receivePurchaseOrderSchema = z.object({
    receiptScanId: zObjectId('Lan quet phieu nhan hang').optional(),
    items: z
        .array(
            z.object({
                index: z.number().int().min(0),
                quantityReceived: z.number().min(0),
                markShortage: z.boolean().optional(),
                note: zOptionalString(),
            })
        )
        .optional(),
    shortageAllocations: z
        .array(
            z.object({
                shortageId: zObjectId('No hang'),
                quantityReceived: z.number().min(0),
                note: zOptionalString(),
            })
        )
        .optional(),
    receivedAt: zOptionalString(),
    note: zOptionalString(),
});

export const linkPurchaseOrderItemMaterialSchema = z.object({
    materialId: zObjectId('Vat tu'),
});

export const createPurchaseOrderItemMaterialSchema = z.object({
    code: zOptionalString(),
    name: zOptionalString(),
    category: zOptionalString(),
    unit: zOptionalString(),
    description: zOptionalString(),
    minStockLevel: z.number().min(0).optional(),
    trackInventory: z.boolean().optional(),
});

export const ignorePurchaseOrderItemInventorySchema = z.object({
    reason: zOptionalString(),
});
