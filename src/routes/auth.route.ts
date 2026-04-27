import { authController } from '@/controllers';
import rateLimitMiddleware from '@/middlewares/limiterResquestMiddleware';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import validator from '@/middlewares/validator';
import {
    changePasswordSchema,
    forgotPasswordSchema,
    loginSchema,
    registerSchema,
    resetPasswordSchema,
} from '@/validations/auth.validation';
import { Router } from 'express';

const router = Router();
const authLimiter = rateLimitMiddleware(60, 10);

router.post('/login', authLimiter, validator(loginSchema), authController.Login);
router.post('/register', validator(registerSchema), authController.Register);
router.post('/refresh-token', authLimiter, authController.RefreshToken);
router.post('/logout', authController.Logout);
router.post('/forgot-password', authLimiter, validator(forgotPasswordSchema), authController.ForgotPassword);
router.post('/reset-password', authLimiter, validator(resetPasswordSchema), authController.ResetPassword);
router.post('/change-password', authenticate, validator(changePasswordSchema), authController.ChangePassword);

export default router;
