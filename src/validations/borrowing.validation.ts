import { ASSET_STATUS } from '@/constant/assetStatus';
import { BORROWING_DIRECTION } from '@/constant/borrowing';
import { zObjectId, zOptionalString, zRequiredNumber, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const transactionTypeSchema = z.enum(['internal', 'external', 'rental']);
const externalTransactionTypeSchema = z.enum(['external', 'rental']);
const qrReturnActionSchema = z.enum(['removed', 'lost', 'damaged', 'left_on_partner']);
const borrowingDirectionSchema = z.nativeEnum(BORROWING_DIRECTION);

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

export const createBorrowingBatchSchema = z
    .object({
        type: externalTransactionTypeSchema,
        direction: borrowingDirectionSchema.optional(),
        // Optional voi lo inbound de ho tro ra soat thuc te; outbound bat buoc phai biet ben nhan.
        partnerName: zOptionalString(),
        contractNo: zOptionalString(),
        contactName: zOptionalString(),
        contactPhone: zOptionalString(),
        partnerAddress: zOptionalString(),
        purpose: zOptionalString(),
        plantId: zObjectId('Co so'),
        area: zOptionalString(),
        borrowTime: zRequiredString('Thoi gian giao / nhan'),
        expectedReturnTime: zOptionalString(),
        plannedQuantity: zRequiredNumber('So luong may', 1, 3000).int(),
        note: zOptionalString(),
        createQrBatch: z.boolean().optional(),
    })
    .superRefine((data, ctx) => {
        if (data.direction !== BORROWING_DIRECTION.OUTBOUND) return;

        if (data.type !== 'external') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['type'],
                message: 'Lo cho muon chi su dung loai giao dich external',
            });
        }
        if (!data.partnerName?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['partnerName'],
                message: 'Doi tac nhan may la bat buoc',
            });
        }
        if (!data.purpose?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['purpose'],
                message: 'Muc dich cho muon la bat buoc',
            });
        }
        if (!data.expectedReturnTime?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expectedReturnTime'],
                message: 'Han tra du kien la bat buoc voi lo cho muon',
            });
        }
        if (data.createQrBatch) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['createQrBatch'],
                message: 'May Hai Dang su dung QR chinh thuc, khong tao QR tam',
            });
        }

        const borrowTime = Date.parse(data.borrowTime);
        const expectedReturnTime = Date.parse(data.expectedReturnTime || '');
        if (!Number.isFinite(borrowTime)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['borrowTime'],
                message: 'Thoi gian ban giao khong hop le',
            });
        }
        if (!Number.isFinite(expectedReturnTime)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expectedReturnTime'],
                message: 'Han tra du kien khong hop le',
            });
        } else if (Number.isFinite(borrowTime) && expectedReturnTime <= borrowTime) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expectedReturnTime'],
                message: 'Han tra phai sau thoi gian ban giao',
            });
        }
    });

// Bo sung thong tin lo sau khi ra soat (doi tac, hop dong, han tra...)
export const updateBorrowingBatchSchema = z.object({
    partnerName: zOptionalString(),
    contractNo: zOptionalString(),
    contactName: zOptionalString(),
    contactPhone: zOptionalString(),
    partnerAddress: zOptionalString(),
    purpose: zOptionalString(),
    area: zOptionalString(),
    expectedReturnTime: zOptionalString(),
    plannedQuantity: z.coerce.number().int().min(1).max(3000).optional(),
    note: zOptionalString(),
});

const imageUrlsSchema = z.array(z.string().url()).max(5).optional();

export const addOutboundBorrowingAssetsSchema = z.object({
    items: z
        .array(
            z.object({
                assetId: zObjectId('Thiet bi'),
                issueCondition: zOptionalString(),
                issueNote: zOptionalString(),
                accessories: z.array(z.string().trim().min(1)).max(30).optional(),
                issueImages: imageUrlsSchema,
            })
        )
        .min(1, { message: 'Can chon it nhat mot may' })
        .max(300, { message: 'Toi da 300 may moi lan them' }),
});

export const rejectOutboundBorrowingBatchSchema = z.object({
    reason: zRequiredString('Ly do tu choi'),
});

export const cancelOutboundBorrowingBatchSchema = z.object({
    reason: zRequiredString('Ly do huy'),
});

export const confirmOutboundHandoverSchema = z
    .object({
        handoverTime: zRequiredString('Thoi gian ban giao'),
        note: zOptionalString(),
        handoverImages: imageUrlsSchema,
    })
    .superRefine((data, ctx) => {
        if (!Number.isFinite(Date.parse(data.handoverTime))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['handoverTime'],
                message: 'Thoi gian ban giao khong hop le',
            });
        }
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

// Nhan nhanh nhieu may chua tung co tren he thong (sap tra ngay) - moi dong toi thieu ten may,
// khong bat brand/type/model de khong can biet du thong tin truoc khi tra.
export const receiveBorrowingBatchBulkSchema = z.object({
    rows: z
        .array(
            z.object({
                name: zRequiredString('Ten may'),
                model: zOptionalString(),
                serial: zOptionalString(),
                partnerMachineCode: zOptionalString(),
                note: zOptionalString(),
            })
        )
        .min(1, { message: 'Can nhap it nhat mot may' })
        .max(500, { message: 'Toi da 500 may moi lan nhan nhanh' }),
    receiveCondition: zOptionalString(),
    receiveNote: zOptionalString(),
});

export const bulkReturnBorrowingBatchSchema = z
    .object({
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
                    returnImages: imageUrlsSchema,
                    qrReturnNote: zOptionalString(),
                })
            )
            .min(1, { message: 'Can chon it nhat mot may de tra' }),
    })
    .superRefine((data, ctx) => {
        if (!Number.isFinite(Date.parse(data.returnTime))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['returnTime'],
                message: 'Thoi gian tra / nhan lai khong hop le',
            });
        }
    });
