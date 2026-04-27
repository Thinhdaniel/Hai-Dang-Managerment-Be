import { z } from 'zod';

export const validationLengthLimit = (label: string, min?: number, max?: number) => {
    const lowerLabel = label.toLowerCase();
    if (min != null && max != null) return `Độ dài ${lowerLabel} phải từ ${min} đến ${max} ký tự`;
    if (min != null) return `Độ dài ${lowerLabel} tối thiểu là ${min} ký tự`;
    if (max != null) return `Độ dài ${lowerLabel} tối đa là ${max} ký tự`;
    return `Độ dài ${lowerLabel} không hợp lệ`;
};

export const validationNumberLimit = (label: string, min?: number, max?: number) => {
    const lowerLabel = label.toLowerCase();
    if (min != null && max != null) return `Giá trị ${lowerLabel} phải từ ${min} đến ${max}`;
    if (min != null) return `Giá trị ${lowerLabel} tối thiểu là ${min}`;
    if (max != null) return `Giá trị ${lowerLabel} tối đa là ${max}`;
    return `Giá trị ${lowerLabel} không hợp lệ`;
};

export const validationRequired = (label: string) => {
    return `${label} không được để trống`;
};

export const validationRegex = (label: string, validNote?: string) => {
    return `${label} không hợp lệ ${validNote ? `( ${validNote} )` : ''}`;
};

// Zod Helpers for convenience
export const zRequiredString = (label: string, min: number = 1) =>
    z
        .string({
            error: (issue) => validationRequired(label),
        })
        .trim()
        .min(1, { message: validationRequired(label) })
        .min(min, { message: validationLengthLimit(label, min) });

export const zRequiredEmail = (label: string = 'Email') =>
    z
        .string({
            error: (issue) => validationRequired(label),
        })
        .trim()
        .min(1, { message: validationRequired(label) })
        .regex(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, {
            message: `${label} không hợp lệ`,
        });

export const zPassword = (label: string = 'Mật khẩu') =>
    z
        .string({
            error: (issue) => validationRequired(label),
        })
        .min(1, { message: validationRequired(label) })
        .min(6, { message: validationLengthLimit(label, 6) });

export const zObjectId = (label: string) =>
    z
        .string({
            error: (issue) => validationRequired(label),
        })
        .trim()
        .min(1, { message: validationRequired(label) })
        .regex(/^[0-9a-fA-F]{24}$/, { message: validationRegex(label, 'phải là ObjectId hợp lệ') });

export const zRequiredNumber = (label: string, min?: number, max?: number) => {
    let schema = z.number({
        error: (issue) => validationRequired(label),
    });
    if (min !== undefined) schema = schema.min(min, { message: validationNumberLimit(label, min) });
    if (max !== undefined) schema = schema.max(max, { message: validationNumberLimit(label, undefined, max) });
    return schema;
};

export const zOptionalString = () => z.string().optional();
export const zOptionalNumber = () => z.number().optional();
export const zOptionalDate = () => z.date().optional();
