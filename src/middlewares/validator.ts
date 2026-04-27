import { BadRequestFormError } from '@/errors/customError';
import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

const validator = (schema: ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = Object.entries(result.error.format())
                .filter(([field]) => field !== '_errors')
                .map(([field, issue]) => ({
                    message: Array.isArray(issue) ? issue[0] : (issue as any)?._errors?.[0] || 'Lỗi không xác định',
                    field,
                }));
            throw new BadRequestFormError('Đã có lỗi xảy ra!', errors);
        }
        req.body = result.data;
        next();
    };
};

export default validator;
