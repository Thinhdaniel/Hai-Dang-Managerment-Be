import { zOptionalString, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const quickSupplierSchema = z.object({
    name: zRequiredString('Tên nhà cung cấp'),
    phone: z.string().trim().regex(/^[0-9]{10,11}$/, 'Số điện thoại phải là 10-11 chữ số').optional().or(z.literal('')),
    address: zOptionalString(),
});

const itemSchema = z.object({
    materialName: zRequiredString('Tên vật tư'),
    unit: zRequiredString('Đơn vị'),
    quantity: zRequiredNumber('Số lượng', 1),
    unitPrice: zRequiredNumber('Đơn giá', 0),
    vatRate: z.number().min(0).max(100).default(0),
    supplierId: z.string().trim().optional(),
    quickSupplier: quickSupplierSchema.optional(),
    note: zOptionalString(),
}).refine(
    (data) => data.supplierId || data.quickSupplier,
    { message: 'Phải chọn nhà cung cấp hoặc tạo mới', path: ['supplierId'] }
);

export const expressDispatchSchema = z.object({
    items: z.array(itemSchema).min(1, { message: 'Phải có ít nhất 1 vật tư' }),
    toPlantId: z.string().trim().min(1, 'Cơ sở nhận không được để trống'),
    note: zOptionalString(),
});
