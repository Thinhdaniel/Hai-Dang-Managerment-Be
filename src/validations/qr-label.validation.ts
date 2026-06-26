import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { QR_LABEL_STATUS, QR_LABEL_TYPE } from '@/constant/qrLabel';
import { zObjectId, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const optionalString = z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined);

const optionalObjectId = (label: string) => zObjectId(label).optional();

const assetPayloadSchema = z.object({
    name: zRequiredString('Ten thiet bi'),
    machineCode: optionalString, // để trống -> BE tự sinh mã thông minh
    serial: optionalString,
    type: zRequiredString('Loai may'),
    model: zRequiredString('Model may'),
    note: optionalString,
    status: z.nativeEnum(ASSET_STATUS).optional(),
    statusNote: optionalString,
    ownershipType: z.nativeEnum(ASSET_OWNERSHIP_TYPE).optional(),
    brandId: zObjectId('Nhan hieu'),
    plantId: zObjectId('Co so'),
    area: optionalString,
    purchaseDate: optionalString,
    purchasePrice: z.number().min(0).optional(),
    specifications: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    imageUrl: optionalString,
    lastMaintenanceDate: optionalString,
    nextMaintenanceDate: optionalString,
});

export const createQrLabelSchema = z.object({
    type: z.nativeEnum(QR_LABEL_TYPE).default(QR_LABEL_TYPE.MACHINE),
    plannedPlantId: optionalObjectId('Co so du kien'),
    plannedArea: optionalString,
    note: optionalString,
});

export const createQrLabelBatchSchema = z.object({
    type: z.nativeEnum(QR_LABEL_TYPE).default(QR_LABEL_TYPE.MACHINE),
    quantity: zRequiredNumber('So luong tem', 1, 3000).int(),
    plantId: optionalObjectId('Co so du kien'),
    area: optionalString,
    note: optionalString,
});

export const activateMachineQrLabelSchema = z.object({
    asset: assetPayloadSchema,
});

export const linkAssetQrLabelSchema = z.object({
    assetId: zObjectId('Thiet bi'),
    replaceExistingPublicId: z.boolean().optional(),
});

export const retireQrLabelSchema = z.object({
    status: z.enum([QR_LABEL_STATUS.RETIRED, QR_LABEL_STATUS.LOST, QR_LABEL_STATUS.DAMAGED]),
    reason: zRequiredString('Ly do'),
    clearAssetPublicId: z.boolean().optional(),
});
