import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

const distributionItemSchema = z.object({
    materialId: zObjectId('Vat tu'),
    unit: zOptionalString(),
    quantity: z.number().gt(0, { message: 'So luong cap phat phai lon hon 0' }),
    quantityRequested: z.number().min(0).optional(),
    quantityDistributed: z.number().min(0).optional(),
    unitPrice: z.number().min(0).optional(),
    vatRate: z.number().min(0).max(100).optional(),
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

export const confirmDistributionSchema = z.object({
    note: zOptionalString(),
});
