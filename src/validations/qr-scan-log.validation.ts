import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

export const createQrScanLogSchema = z.object({
    rawValue: zOptionalString(),
    publicId: zOptionalString(),
    labelId: zObjectId('Tem QR').optional(),
    assetId: zObjectId('Thiet bi').optional(),
    action: z.enum([
        'open_profile',
        'quick_update',
        'stocktake',
        'transfer_scan',
        'maintenance_quick_create',
        'maintenance_quick_create_success',
        'borrowing_receive',
        'borrowing_receive_success',
        'borrowing_return',
        'borrowing_return_success',
    ]),
    result: z.enum([
        'resolved',
        'not_found',
        'ambiguous',
        'duplicate',
        'present',
        'wrong_area',
        'wrong_plant',
        'success',
        'failed',
    ]),
    source: z.enum(['camera', 'manual', 'qr_label', 'legacy_asset', 'search', 'unknown']).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
