import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createMaterialRecipientSchema = z.object({
    employeeCode: zRequiredString('Ma cong nhan'),
    fullName: zRequiredString('Ho ten'),
    plantId: zObjectId('Co so').optional(),
    department: zOptionalString(),
    lineName: zOptionalString(),
    phone: zOptionalString(),
    isActive: z.boolean().optional(),
});

export const updateMaterialRecipientSchema = z.object({
    employeeCode: zOptionalString(),
    fullName: zOptionalString(),
    department: zOptionalString(),
    lineName: zOptionalString(),
    phone: zOptionalString(),
    isActive: z.boolean().optional(),
});

export const createMaterialUsageCampaignSchema = z.object({
    plantId: zObjectId('Co so').optional(),
    productionItemId: zObjectId('Ma hang').optional(),
    itemCode: zOptionalString(),
    itemName: zOptionalString(),
    orderCode: zOptionalString(),
    startedAt: zOptionalString(),
    note: zOptionalString(),
});

export const openMaterialRecallSchema = z.object({
    dueAt: zRequiredString('Han thu hoi'),
    note: zOptionalString(),
});

export const resolveMaterialCustodySchema = z.object({
    quantity: z.number().positive({ message: 'So luong xu ly phai lon hon 0' }),
    resolution: z.enum(['usable', 'repair', 'damaged', 'lost']),
    occurredAt: zOptionalString(),
    note: zOptionalString(),
    evidenceUrls: z.array(z.string().url()).max(10).optional(),
});

const custodyTargetSchema = {
    holderType: z.enum(['employee', 'team']),
    recipientId: zObjectId('Nguoi nhan').optional(),
    holderName: zOptionalString(),
    holderCode: zOptionalString(),
    department: zOptionalString(),
    lineName: zOptionalString(),
    campaignId: zObjectId('Dot su dung vat tu'),
    dueAt: zOptionalString(),
    note: zOptionalString(),
};

export const reissueReusableMaterialSchema = z.object({
    plantId: zObjectId('Co so').optional(),
    materialId: zObjectId('Vat tu'),
    quantity: z.number().positive({ message: 'So luong cap phai lon hon 0' }),
    ...custodyTargetSchema,
});

export const createMaterialCustodyOpeningBalanceSchema = z.object({
    plantId: zObjectId('Co so').optional(),
    materialId: zObjectId('Vat tu'),
    quantity: z.number().positive({ message: 'So luong dau ky phai lon hon 0' }),
    unitPrice: z.number().nonnegative().optional(),
    issuedAt: zOptionalString(),
    ...custodyTargetSchema,
});

export const transferMaterialCustodySchema = z.object({
    quantity: z.number().positive({ message: 'So luong chuyen phai lon hon 0' }),
    ...custodyTargetSchema,
});
