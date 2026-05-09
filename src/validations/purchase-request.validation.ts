import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

const requestItemSchema = z.object({
    materialId: zObjectId('Vat tu').optional(),
    materialName: z.string().trim().min(1, { message: 'Ten vat tu khong duoc de trong' }),
    unit: z.string().trim().optional(),
    proposedBy: z.string().trim().min(1, { message: 'Nguoi de xuat khong duoc de trong' }),
    purpose: z.string().trim().min(1, { message: 'Noi dung su dung khong duoc de trong' }),
    plantId: zObjectId('Co so').optional(),
    quantityRequested: z.number().gt(0, { message: 'So luong de xuat phai lon hon 0' }),
    quantityOrdered: z.number().min(0).optional(),
    unitPrice: z.number().min(0).optional(),
    totalPrice: z.number().min(0).optional(),
    // FE gửi 0-100, BE tự chia 100 trong service
    vatRate: z.number().min(0).max(100).optional(),
    vatAmount: z.number().min(0).optional(),
    totalWithVat: z.number().min(0).optional(),
    orderDate: z.string().optional(),
    receivedDate: z.string().optional(),
    supplierId: zObjectId('Nha cung cap').optional(),
    supplierName: zOptionalString(),
    supplierNote: zOptionalString(),
    note: zOptionalString(),
});

const approvalItemSchema = z.object({
    materialId: zObjectId('Vat tu').optional(),
    quantityApproved: z.number().min(0).optional(),
    estimatedPrice: z.number().min(0).optional(),
    supplierId: zObjectId('Nha cung cap').optional(),
    note: zOptionalString(),
});

export const createPurchaseRequestSchema = z.object({
    plantId: zObjectId('Co so').optional(),
    requestMonth: z.number().int().min(1).max(12).optional(),
    requestYear: z.number().int().min(2020).optional(),
    status: z.enum(['draft', 'pending']).optional(),
    items: z.array(requestItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }),
    note: zOptionalString(),
});

export const updatePurchaseRequestSchema = z.object({
    plantId: zObjectId('Co so').optional(),
    requestMonth: z.number().int().min(1).max(12).optional(),
    requestYear: z.number().int().min(2020).optional(),
    status: z.enum(['draft', 'pending']).optional(),
    items: z.array(requestItemSchema).min(1, { message: 'Phai co it nhat 1 vat tu' }).optional(),
    note: zOptionalString(),
});

export const approvePurchaseRequestSchema = z
    .object({
        items: z.array(approvalItemSchema).optional(),
        note: zOptionalString(),
    })
    .default({});

export const rejectPurchaseRequestSchema = z.object({
    reason: z.string().trim().min(1, { message: 'Ly do tu choi khong duoc de trong' }),
});

export const consolidatePurchaseRequestsSchema = z.object({
    requestIds: z.array(zObjectId('Phieu de xuat')).min(1, { message: 'Phai chon it nhat 1 phieu de xuat' }),
    supplierId: zObjectId('Nha cung cap').optional(),
    note: zOptionalString(),
});
