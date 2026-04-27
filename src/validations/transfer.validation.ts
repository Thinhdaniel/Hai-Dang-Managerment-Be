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
