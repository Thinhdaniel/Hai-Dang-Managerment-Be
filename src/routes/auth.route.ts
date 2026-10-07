import { authController } from '@/controllers';
import { USER_ROLE } from '@/constant/allowedRoles';
import { TooManyRequestsError } from '@/errors/customError';
import rateLimitMiddleware from '@/middlewares/limiterResquestMiddleware';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import {
    changePasswordSchema,
    forgotPasswordSchema,
    loginSchema,
    registerSchema,
    resetPasswordSchema,
} from '@/validations/auth.validation';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();
const authLimiter = rateLimitMiddleware(60, 10);
const passwordChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    // Authenticate runs first. Workers on the same factory network must not block each other.
    keyGenerator: (req) => req.userId!,
    handler: (_req, res, next) => {
        const seconds = Number(res.getHeader('Retry-After')) || 15 * 60;
        next(new TooManyRequestsError(`Bạn đã thử đổi mật khẩu quá nhiều lần. Thử lại sau ${seconds} giây.`));
    },
});

router.post('/login', authLimiter, validator(loginSchema), authController.Login);
router.post('/register', validator(registerSchema), authController.Register);
router.post('/refresh-token', authLimiter, authController.RefreshToken);
router.post('/logout', authController.Logout);
router.post('/forgot-password', authLimiter, validator(forgotPasswordSchema), authController.ForgotPassword);
router.post('/reset-password', authLimiter, validator(resetPasswordSchema), authController.ResetPassword);
router.post(
    '/change-password',
    authenticate,
    authorize(USER_ROLE.WORKER),
    passwordChangeLimiter,
    validator(changePasswordSchema),
    authController.ChangePassword
);

export default router;
