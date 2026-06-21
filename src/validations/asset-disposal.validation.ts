import {
    ASSET_DISPOSAL_ACTION,
    ASSET_DISPOSAL_CONDITION,
    ASSET_DISPOSAL_ITEM_STATUS,
    ASSET_DISPOSAL_SOURCE_TYPE,
} from '@/constant/assetDisposal';
import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const itemFieldsSchema = {
    sourceType: z.nativeEnum(ASSET_DISPOSAL_SOURCE_TYPE).optional(),
    assetId: zObjectId('Thiet bi').optional(),
    qrLabelId: zObjectId('Tem QR').optional(),
    publicId: zOptionalString(),
    machineCode: zOptionalString(),
    name: zOptionalString(),
    type: zOptionalString(),
    model: zOptionalString(),
    serial: zOptionalString(),
    plantId: zObjectId('Co so').optional(),
    area: zOptionalString(),
    condition: z.nativeEnum(ASSET_DISPOSAL_CONDITION).optional(),
    reason: zOptionalString(),
    suggestedAction: z.nativeEnum(ASSET_DISPOSAL_ACTION).optional(),
    estimatedValue: z.number().min(0).optional(),
    finalValue: z.number().min(0).optional(),
    photos: z.array(z.string()).max(8).optional(),
    note: zOptionalString(),
};

export const createAssetDisposalBatchSchema = z.object({
    plantId: zObjectId('Co so'),
    area: zOptionalString(),
    reason: zRequiredString('Ly do thanh ly'),
    note: zOptionalString(),
});

export const updateAssetDisposalBatchSchema = z.object({
    plantId: zObjectId('Co so').optional(),
    area: zOptionalString(),
    reason: zOptionalString(),
    note: zOptionalString(),
});

export const createAssetDisposalItemSchema = z
    .object(itemFieldsSchema)
    .refine((value) => Boolean(value.assetId || value.publicId || value.machineCode || value.name), {
        message: 'Can chon may, quet QR hoac nhap thong tin may thanh ly',
        path: ['assetId'],
    });

export const updateAssetDisposalItemSchema = z.object({
    ...itemFieldsSchema,
    status: z.nativeEnum(ASSET_DISPOSAL_ITEM_STATUS).optional(),
});

export const scanAssetDisposalQrSchema = z.object({
    rawValue: zRequiredString('Ma QR'),
    condition: z.nativeEnum(ASSET_DISPOSAL_CONDITION).optional(),
    reason: zOptionalString(),
    suggestedAction: z.nativeEnum(ASSET_DISPOSAL_ACTION).optional(),
    note: zOptionalString(),
});

export const submitAssetDisposalBatchSchema = z.object({
    note: zOptionalString(),
});

export const approveAssetDisposalBatchSchema = z.object({
    note: zOptionalString(),
});

export const cancelAssetDisposalBatchSchema = z.object({
    reason: zRequiredString('Ly do huy'),
});
