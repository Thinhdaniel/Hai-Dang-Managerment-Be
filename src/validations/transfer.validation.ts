import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createTransferSchema = z.object({
    assetId: zObjectId('Thiet bi'),
    toPlantId: zObjectId('Co so den'),
    reason: zRequiredString('Ly do dieu chuyen'),
    transferDate: zRequiredString('Ngay dieu chuyen'),
    toArea: zOptionalString(),
    note: zOptionalString(),
});

export const rejectTransferSchema = z.object({
    reason: zRequiredString('Ly do tu choi'),
});

export const cancelTransferSchema = z.object({
    reason: zRequiredString('Ly do huy'),
});

export const completeTransferSchema = z.object({
    receivedBy: zRequiredString('Nguoi nhan ban giao'),
    handoverImages: z.array(z.string().url()).max(3).optional(),
});
