import { zObjectId, zOptionalString, zRequiredString } from '@/lib/validation';
import { z } from 'zod';

const transactionTypeSchema = z.enum(['internal', 'external', 'rental']);

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
