import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

export const createMaintenanceSchema = z.object({
    assetId: zObjectId('Thiet bi'),
    type: z.enum(['periodic', 'emergency', 'inspection']),
    description: zRequiredString('Noi dung bao tri'),
    startDate: zRequiredString('Ngay bat dau'),
    endDate: zOptionalString(),
    technician: zOptionalString(),
    cost: z.number().min(0).optional(),
    note: zOptionalString(),
});

export const updateMaintenanceSchema = z.object({
    type: z.enum(['periodic', 'emergency', 'inspection']).optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'overdue']).optional(),
    description: zOptionalString(),
    startDate: zOptionalString(),
    endDate: zOptionalString(),
    technician: zOptionalString(),
    cost: z.number().min(0).optional(),
    note: zOptionalString(),
});

export const completeMaintenanceSchema = z.object({
    endDate: zRequiredString('Ngay hoan thanh'),
    note: zOptionalString(),
    cost: z.number().min(0).optional(),
});
