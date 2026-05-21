import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const distributionItemSchema = z.object({
    materialId: zObjectId('Vat tu').optional(),
    materialName: zOptionalString(),
    unit: zOptionalString(),
    quantity: z.number().min(0, { message: 'So luong cap phat khong hop le' }),
    quantityRequested: z.number().min(0).optional(),
    quantityDistributed: z.number().min(0).optional(),
    quantityShortage: z.number().min(0).optional(),
    sourceRequestItemIndex: z.number().int().min(0).optional(),
    sourceShortageId: zObjectId('Dong cap bu').optional(),
    fulfillmentStatus: z.enum(['fulfilled', 'partial', 'not_supplied']).optional(),
    unitPrice: z.number().min(0).optional(),
    vatRate: z.number().min(0).max(100).optional(),
    catalogStatus: z.enum(['matched', 'unmatched', 'ignored']).optional(),
    inventorySkipReason: zOptionalString(),
    adjustReason: zOptionalString(),
    distributedDate: zOptionalString(),
    note: zOptionalString(),
});

export const createDistributionRecordSchema = z.object({
    fromPlantId: zObjectId('Co so xuat').optional(),
    toPlantId: zObjectId('Co so nhan').optional(),
    purchaseOrderId: zObjectId('Don dat hang').optional(),
    supplyRequestId: zObjectId('Phieu de xuat cap vat tu').optional(),
    distributedAt: zOptionalString(),
    items: z.array(distributionItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
    status: z.enum(['pending', 'distributed']).optional(),
    note: zOptionalString(),
});

export const createCompensationDistributionRecordSchema = z.object({
    shortageIds: z.array(zObjectId('Dong can cap bu')).min(1, { message: 'Phai chon it nhat 1 dong can cap bu' }),
    distributedAt: zOptionalString(),
    items: z.array(distributionItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu cap bu' }),
    note: zOptionalString(),
});

export const createInternalDistributionRecordSchema = z.object({
    distributedAt: zOptionalString(),
    requesterName: zRequiredString('Ten nguoi xin cap'),
    targetDepartment: zOptionalString(),
    targetLine: zOptionalString(),
    items: z.array(distributionItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
    note: zOptionalString(),
});

export const confirmDistributionSchema = z.object({
    note: zOptionalString(),
});

export const createInternalDraftSchema = z.object({
    targetDepartment: zOptionalString(),
    targetLine: zOptionalString(),
    requesterName: zRequiredString('Ten nguoi xin cap'),
    note: zOptionalString(),
    distributedAt: zOptionalString(),
    status: z.enum(['draft', 'confirmed']).optional(),
    items: z.array(distributionItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
});

export const appendInternalItemsSchema = z.object({
    items: z.array(distributionItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
});

export const finalizeInternalDraftSchema = z.object({
    note: zOptionalString(),
});
