import { BadRequestError, TooManyRequestsError } from '@/errors/customError';
import { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const rateLimitMiddleware = (timeWindow: number, maxRequest: number) => {
    return rateLimit({
        windowMs: timeWindow * 1000,
        max: maxRequest,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req: Request, res: Response, next: NextFunction) => {
            const retryAfterHeader = res.getHeader('Retry-After');
            let timeLeft = timeWindow;
            if (retryAfterHeader) {
                timeLeft = Math.max(parseInt(retryAfterHeader as string, 10), 1);
            }
            return next(new BadRequestError(`Thử lại sau ${timeLeft} giây`));
        },
    });
};

export default rateLimitMiddleware;

/**
 * Rate limit sau authenticate, ưu tiên userId để nhiều nhân viên chung mạng nhà máy
 * không chặn lẫn nhau. IP chỉ là fallback cho request không có user context.
 */
export const userRateLimitMiddleware = (timeWindow: number, maxRequest: number) =>
    rateLimit({
        windowMs: timeWindow * 1000,
        max: maxRequest,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req: Request) => req.userId || ipKeyGenerator(req.ip || 'unknown'),
        handler: (_req: Request, res: Response, next: NextFunction) => {
            const retryAfterHeader = res.getHeader('Retry-After');
            const timeLeft = retryAfterHeader ? Math.max(parseInt(String(retryAfterHeader), 10), 1) : timeWindow;
            return next(new TooManyRequestsError(`Trợ lý đang nhận quá nhiều câu hỏi. Thử lại sau ${timeLeft} giây`));
        },
    });
