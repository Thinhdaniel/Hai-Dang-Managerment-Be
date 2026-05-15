import { zOptionalString, zObjectId, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';

export const createAssetSchema = z.object({
    name: zRequiredString('Ten thiet bi'),
    machineCode: zRequiredString('Ma may'),
    serial: zOptionalString(),
    type: zRequiredString('Loai may'),
    model: zRequiredString('Model may'),
    note: zOptionalString(),
    status: z.nativeEnum(ASSET_STATUS).optional(),
    statusNote: zOptionalString(),
    ownershipType: z.nativeEnum(ASSET_OWNERSHIP_TYPE).optional(),
    brandId: zObjectId('Nhan hieu'),
    plantId: zObjectId('Co so'),
    area: zOptionalString(),
    purchaseDate: zOptionalString(),
    purchasePrice: zRequiredNumber('Gia mua', 0).optional(),
    specifications: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    imageUrl: zOptionalString(),
    lastMaintenanceDate: zOptionalString(),
    nextMaintenanceDate: zOptionalString(),
});

export const updateAssetSchema = z.object({
    name: zOptionalString(),
    machineCode: zOptionalString(),
    serial: zOptionalString(),
    type: zOptionalString(),
    model: zOptionalString(),
    note: zOptionalString(),
    status: z.nativeEnum(ASSET_STATUS).optional(),
    statusNote: zOptionalString(),
    ownershipType: z.nativeEnum(ASSET_OWNERSHIP_TYPE).optional(),
    brandId: zObjectId('Nhan hieu').optional(),
    plantId: zObjectId('Co so').optional(),
    area: zOptionalString(),
    purchaseDate: zOptionalString(),
    purchasePrice: z.number().min(0).optional(),
    specifications: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    imageUrl: zOptionalString(),
    lastMaintenanceDate: zOptionalString(),
    nextMaintenanceDate: zOptionalString(),
});
