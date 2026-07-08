import { ASSET_STATUS } from '@/constant/assetStatus';
import { zObjectId, zOptionalString, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const transactionTypeSchema = z.enum(['internal', 'external', 'rental']);
const externalTransactionTypeSchema = z.enum(['external', 'rental']);
const qrReturnActionSchema = z.enum(['removed', 'lost', 'damaged', 'left_on_partner']);

const optionalString = z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined);

const borrowingBatchAssetSchema = z.object({
    name: zRequiredString('Ten thiet bi'),
    machineCode: optionalString,
    serial: optionalString,
    type: zRequiredString('Loai may'),
    model: zRequiredString('Model may'),
    brandId: zObjectId('Nhan hieu'),
    plantId: zObjectId('Co so').optional(),
    area: optionalString,
    note: optionalString,
    imageUrl: optionalString,
    purchaseDate: optionalString,
    purchasePrice: z.number().min(0).optional(),
    specifications: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    status: z.nativeEnum(ASSET_STATUS).optional(),
});

export const createBorrowingSchema = z
    .object({
        assetId: zObjectId('Thiet bi'),
        type: transactionTypeSchema,
        borrowerId: zObjectId('Nguoi muon').optional(),
        borrowerName: zOptionalString(),
        partnerName: zOptionalString(),
        borrowTime: zRequiredString('Thoi gian bat dau'),
        purpose: zOptionalString(),
        location: zOptionalString(),
        cost: z.coerce.number().min(0, { message: 'Chi phi phai lon hon hoac bang 0' }).optional(),
        note: zOptionalString(),
    })
    .superRefine((data, ctx) => {
        if (data.type === 'internal') {
            if (!data.borrowerName?.trim()) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['borrowerName'],
                    message: 'Nguoi muon la bat buoc voi giao dich noi bo',
                });
            }
            if (!data.purpose?.trim()) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['purpose'],
                    message: 'Muc dich la bat buoc voi giao dich noi bo',
                });
            }
        }

        if (data.type === 'external' || data.type === 'rental') {
            if (!data.partnerName?.trim()) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['partnerName'],
                    message: 'Doi tac / cong ty la bat buoc',
                });
            }
        }

        if (data.type === 'rental' && data.cost == null) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['cost'],
                message: 'Chi phi la bat buoc voi giao dich thue may',
            });
        }
    });

export const returnBorrowingSchema = z.object({
    returnTime: zRequiredString('Thoi gian tra'),
    note: zOptionalString(),
});

export const createBorrowingBatchSchema = z.object({
    type: externalTransactionTypeSchema,
    // Optional de ho tro ra soat thuc te: chua biet may cua ai van ghi nhan duoc, bo sung sau
    partnerName: zOptionalString(),
    contractNo: zOptionalString(),
    plantId: zObjectId('Co so'),
    area: zOptionalString(),
    borrowTime: zRequiredString('Thoi gian nhan'),
    expectedReturnTime: zOptionalString(),
    plannedQuantity: zRequiredNumber('So luong may', 1, 3000).int(),
    note: zOptionalString(),
    createQrBatch: z.boolean().optional(),
});

// Bo sung thong tin lo sau khi ra soat (doi tac, hop dong, han tra...)
export const updateBorrowingBatchSchema = z.object({
    partnerName: zOptionalString(),
    contractNo: zOptionalString(),
    area: zOptionalString(),
    expectedReturnTime: zOptionalString(),
    note: zOptionalString(),
});

export const createBorrowingBatchQrSchema = z.object({
    quantity: zRequiredNumber('So luong tem', 1, 3000).int().optional(),
});

export const receiveBorrowingBatchByQrSchema = z.object({
    // Bo trong = nhan may KHONG dan tem (khong duoc dan/danh dau len may khach)
    publicId: zOptionalString(),
    asset: borrowingBatchAssetSchema,
    partnerMachineCode: zOptionalString(),
    receiveCondition: zOptionalString(),
    receiveNote: zOptionalString(),
});

export const bulkReturnBorrowingBatchSchema = z.object({
    returnTime: zRequiredString('Thoi gian tra'),
    note: zOptionalString(),
    items: z
        .array(
            z.object({
                borrowingId: zObjectId('Giao dich'),
                // Optional vi may nhan khong tem thi khong co QR de xu ly; service van bat buoc khi may co tem
                qrReturnAction: qrReturnActionSchema.optional(),
                returnCondition: zOptionalString(),
                returnNote: zOptionalString(),
                qrReturnNote: zOptionalString(),
            })
        )
        .min(1, { message: 'Can chon it nhat mot may de tra' }),
});
