import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const zOptionalCost = z.number().min(0).optional();

const externalRepairSchema = z
    .object({
        vendorName: zOptionalString(),
        sentOutAt: zOptionalString(),
        expectedReturnAt: zOptionalString(),
        returnedAt: zOptionalString(),
        estimateCost: zOptionalCost,
        actualCost: zOptionalCost,
        invoiceNo: zOptionalString(),
        invoiceImageUrl: zOptionalString(),
        costItems: z
            .array(
                z.object({
                    name: zOptionalString(),
                    amount: zOptionalCost,
                    note: zOptionalString(),
                })
            )
            .optional(),
    })
    .optional();

export const createMaintenanceSchema = z.object({
    assetId: zObjectId('Thiet bi'),
    assetIds: z.array(zObjectId('Thiet bi')).optional(),
    type: z.enum(['periodic', 'emergency', 'inspection']),
    repairMode: z.enum(['internal', 'external']).optional(),
    description: zRequiredString('Noi dung bao tri'),
    startDate: zRequiredString('Ngay bat dau'),
    endDate: zOptionalString(),
    technician: zOptionalString(),
    cost: zOptionalCost,
    externalRepair: externalRepairSchema,
    note: zOptionalString(),
});

export const updateMaintenanceSchema = z.object({
    assetId: zObjectId('Thiet bi').optional(),
    assetIds: z.array(zObjectId('Thiet bi')).optional(),
    type: z.enum(['periodic', 'emergency', 'inspection']).optional(),
    repairMode: z.enum(['internal', 'external']).optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'overdue', 'cancelled']).optional(),
    approvalStatus: z.enum(['none', 'pending', 'approved', 'rejected']).optional(),
    description: zOptionalString(),
    startDate: zOptionalString(),
    endDate: zOptionalString(),
    technician: zOptionalString(),
    cost: zOptionalCost,
    externalRepair: externalRepairSchema,
    note: zOptionalString(),
});

export const completeMaintenanceSchema = z.object({
    endDate: zRequiredString('Ngay hoan thanh'),
    note: zOptionalString(),
    cost: zOptionalCost,
    externalRepair: externalRepairSchema,
});

export const approveMaintenanceSchema = z.object({
    note: zOptionalString(),
});

export const rejectMaintenanceSchema = z.object({
    rejectReason: zRequiredString('Ly do tu choi'),
});
