import { zObjectId, zOptionalString } from '@/lib/validation';
import { z } from 'zod';

const productionDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày sản xuất phải có định dạng YYYY-MM-DD')
    .refine((value) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, 'Ngày sản xuất không hợp lệ');

const timeSlotSchema = z
    .object({
        key: z
            .string()
            .trim()
            .min(1)
            .max(24)
            .regex(/^[A-Za-z0-9:_-]+$/, 'Mã khung giờ không hợp lệ'),
        // Nhãn do server sinh từ mốc phút (buildTimeSlotLabel); nhận vào chỉ để
        // tương thích client cũ, giá trị gửi lên bị bỏ qua.
        label: z.string().trim().max(30).optional(),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
        kind: z.enum(['regular', 'overtime']).default('regular'),
        isActive: z.boolean().default(true),
    })
    .refine((slot) => slot.endMinute > slot.startMinute, {
        message: 'Thời gian kết thúc phải sau thời gian bắt đầu',
        path: ['endMinute'],
    });

const timeSlotsSchema = z
    .array(timeSlotSchema)
    .min(1, 'Cần ít nhất một khung giờ')
    .max(24, 'Tối đa 24 khung giờ')
    .superRefine((slots, ctx) => {
        const keys = new Set<string>();
        slots.forEach((slot, index) => {
            if (keys.has(slot.key)) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Mã khung giờ bị trùng',
                    path: [index, 'key'],
                });
            }
            keys.add(slot.key);
        });
    });

export const createProductionLineSchema = z.object({
    plantId: zObjectId('Cơ sở'),
    code: z.string().trim().min(1).max(30),
    name: zOptionalString(),
    leaderName: zOptionalString(),
    sortOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
});

export const updateProductionLineSchema = createProductionLineSchema.omit({ plantId: true }).partial();

export const createProductionItemSchema = z.object({
    plantId: zObjectId('Cơ sở'),
    code: z.string().trim().min(1).max(60),
    name: zOptionalString(),
    unit: z.string().trim().min(1).max(30).default('SP'),
    unitPrice: z.number().min(0).max(1000000000).default(0),
    isActive: z.boolean().default(true),
});

export const updateProductionItemSchema = createProductionItemSchema.omit({ plantId: true }).partial();

const productionOpeningBalanceEntrySchema = z
    .object({
        lineId: zObjectId('Chuyền'),
        itemId: zObjectId('Mã hàng').nullable().optional(),
        orderCode: z.string().trim().max(80).optional(),
        quantity: z.number().positive().max(1_000_000_000),
        unitPrice: z.number().min(0).max(1_000_000_000).nullable().optional(),
    })
    .superRefine((value, ctx) => {
        if (!value.itemId && value.orderCode) {
            ctx.addIssue({
                code: 'custom',
                message: 'Cần chọn mã hàng trước khi nhập mã đơn hàng',
                path: ['orderCode'],
            });
        }
    });

export const createProductionOpeningBalanceSchema = z.object({
    plantId: zObjectId('Cơ sở'),
    cutoffDate: productionDateSchema,
    note: z.string().trim().min(3, 'Cần ghi rõ nguồn hoặc lý do nhập đầu kỳ').max(500),
    entries: z
        .array(productionOpeningBalanceEntrySchema)
        .min(1, 'Cần ít nhất một dòng sản lượng đầu kỳ')
        .max(200, 'Tối đa 200 dòng khi nhập thủ công'),
});

export const importProductionOpeningBalanceSchema = z.object({
    plantId: zObjectId('Cơ sở'),
    cutoffDate: productionDateSchema,
    note: z.string().trim().min(3, 'Cần ghi rõ nguồn file đầu kỳ').max(500),
});

export const voidProductionOpeningBalanceSchema = z.object({
    reason: z.string().trim().min(5, 'Cần ghi rõ lý do hủy số liệu đầu kỳ').max(500),
});

export const createProductionDaySchema = z.object({
    plantId: zObjectId('Cơ sở'),
    productionDate: productionDateSchema,
    timeSlots: timeSlotsSchema.optional(),
});

export const updateProductionTimeSlotsSchema = z.object({
    timeSlots: timeSlotsSchema,
});

export const transitionProductionDaySchema = z.object({
    note: z.string().trim().max(500).optional(),
});

export const updateProductionReminderSettingsSchema = z
    .object({
        plantId: zObjectId('Cơ sở'),
        enabled: z.boolean(),
        graceMinutes: z.number().int().min(0).max(15),
        repeatMinutes: z.number().int().min(5).max(30),
        escalationMinutes: z.number().int().min(5).max(120),
        escalateToManagers: z.boolean(),
        telegramFallback: z.boolean(),
        underTargetEnabled: z.boolean(),
        underTargetThreshold: z.number().int().min(10).max(100),
        additionalRecipientIds: z.array(zObjectId('Người nhận')).max(50).default([]),
    })
    .superRefine((value, ctx) => {
        if (value.escalationMinutes < value.repeatMinutes) {
            ctx.addIssue({
                code: 'custom',
                message: 'Thời gian báo quản lý phải sau ít nhất một chu kỳ nhắc',
                path: ['escalationMinutes'],
            });
        }
        if (new Set(value.additionalRecipientIds).size !== value.additionalRecipientIds.length) {
            ctx.addIssue({
                code: 'custom',
                message: 'Danh sách người nhận đang bị trùng',
                path: ['additionalRecipientIds'],
            });
        }
    });

export const testProductionReminderSchema = z.object({
    plantId: zObjectId('Cơ sở'),
});

export const addProductionDayLineSchema = z.object({
    lineId: zObjectId('Chuyền'),
});

export const configureProductionLineSchema = z
    .object({
        workerCount: z.number().int().min(0).max(1000),
        workerCountConfirmed: z.boolean().default(true),
        itemId: zObjectId('Mã hàng').optional(),
        hourlyQuota: z.number().min(0).max(10000000).optional(),
        startSlotKey: zOptionalString(),
    })
    .superRefine((value, ctx) => {
        if (value.itemId && value.hourlyQuota === undefined) {
            ctx.addIssue({ code: 'custom', message: 'Cần nhập khoán giờ', path: ['hourlyQuota'] });
        }
        if (!value.itemId && value.hourlyQuota !== undefined) {
            ctx.addIssue({ code: 'custom', message: 'Cần chọn mã hàng', path: ['itemId'] });
        }
    });

export const createProductionRunSchema = z.object({
    itemId: zObjectId('Mã hàng'),
    hourlyQuota: z.number().min(0).max(10000000),
    startedSlotKey: z.string().trim().min(1).max(24),
});

export const correctProductionLineSetupSchema = z.object({
    itemId: zObjectId('Mã hàng'),
    hourlyQuota: z.number().min(0).max(10000000),
    reason: z.string().trim().min(5, 'Cần ghi rõ lý do sửa mã').max(500),
    confirmed: z.literal(true, { error: 'Cần xác nhận tính lại toàn bộ dữ liệu trong ngày' }),
});

export const upsertHourlyProductionEntrySchema = z.object({
    runId: zObjectId('Đợt mã hàng'),
    quantity: z.number().int().min(0).max(100000000),
    note: zOptionalString(),
    clientMutationId: z
        .string()
        .trim()
        .min(8)
        .max(80)
        .regex(/^[A-Za-z0-9:_-]+$/, 'Mã đồng bộ không hợp lệ')
        .optional(),
    // null nghĩa là thiết bị tin rằng ô này chưa có dữ liệu. Client cũ không
    // gửi field này vẫn giữ nguyên hành vi ghi đè trước đây.
    expectedUpdatedAt: z.string().datetime().nullable().optional(),
});

const productionPlanAllocationSchema = z.object({
    id: zObjectId('Phân bổ').optional(),
    lineId: zObjectId('Chuyền'),
    itemId: zObjectId('Mã hàng'),
    orderCode: z.string().trim().max(80).optional(),
    plannedQuantity: z.number().int().min(1).max(100000000),
    hourlyQuota: z.number().positive().max(10000000),
    startSlotKey: z.string().trim().min(1).max(24),
    endSlotKey: z.string().trim().min(1).max(24),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    dueDate: productionDateSchema.optional(),
    note: zOptionalString(),
});

export const createProductionPlanSchema = z.object({
    plantId: zObjectId('Cơ sở'),
    productionDate: productionDateSchema,
});

export const updateProductionPlanSchema = z.object({
    revision: z.number().int().min(0),
    changeReason: z.string().trim().min(3, 'Cần nêu lý do điều chỉnh').max(500),
    allocations: z.array(productionPlanAllocationSchema).max(200, 'Tối đa 200 phân bổ mỗi ngày'),
});

export const publishProductionPlanSchema = z.object({
    revision: z.number().int().min(0),
    note: z.string().trim().max(500).optional(),
});

export const reopenProductionPlanSchema = z.object({
    revision: z.number().int().min(0),
    reason: z.string().trim().min(3, 'Cần nhập lý do mở lại kế hoạch').max(500),
});

export const carryOverProductionPlanSchema = z.object({
    revision: z.number().int().min(0),
    sourcePlanId: zObjectId('Kế hoạch nguồn').optional(),
});
