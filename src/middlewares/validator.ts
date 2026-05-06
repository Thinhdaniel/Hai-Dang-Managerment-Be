import { BadRequestFormError } from '@/errors/customError';
import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

const validator = (schema: ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        // Normalize body: nếu undefined (PATCH không body) thì parse {} tránh Zod v4 reject
        const body = req.body !== undefined && req.body !== null ? req.body : {};
        const result = schema.safeParse(body);
        if (!result.success) {
            // Dùng result.error.issues (Zod v4 stable API) thay vì format()
            const errors = (result.error.issues ?? []).map((issue) => ({
                message: issue.message || 'Lỗi không xác định',
                field: issue.path?.join('.') || '_errors',
            }));
            throw new BadRequestFormError('Đã có lỗi xảy ra!', errors.length > 0 ? errors : [{ message: 'Dữ liệu không hợp lệ', field: '_errors' }]);
        }
        req.body = result.data;
        next();
    };
};

export default validator;
