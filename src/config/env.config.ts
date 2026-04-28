import { VALIDATION_MESSAGES } from '@/constant/messages';
import 'dotenv/config';
import { SignOptions } from 'jsonwebtoken';
import z from 'zod';

const envVarsSchema = z.object({
    // SERVER
    PORT: z.coerce.number().default(8000),
    APP_HOST: z.string().default('0.0.0.0'),
    CLIENT_URL: z.string().default('http://localhost:5173'),
    RESET_PASSWORD_URL: z.string().optional().describe('Custom URL for password reset page (e.g., https://yourdomain.com/reset-password)'),
    ALLOWED_ORIGINS: z.string().optional().describe('Comma-separated list of allowed CORS origins'),
    MONGODB_URL_DEV: z.string().describe('Local Mongo DB'),
    AUTH_BYPASS: z
        .string()
        .optional()
        .transform((value) => value === 'true'),
    SYNC_INDEXES: z
        .string()
        .optional()
        .transform((value) => value === 'true'),
    // TOKEN
    JWT_ACCESS_TOKEN_KEY: z.string().min(1, { message: VALIDATION_MESSAGES.JWT_ACCESS_TOKEN_REQUIRED }),
    JWT_REFRESH_TOKEN_KEY: z.string().optional(),
    JWT_VERIFY_TOKEN_KEY: z.string().min(1, { message: VALIDATION_MESSAGES.JWT_VERIFY_TOKEN_REQUIRED }),
    JWT_VERIFY_EXPIRATION: z.string().default('5m'),
    JWT_ACCESS_EXPIRATION: z.string().default('15m'),
    JWT_REFRESH_EXPIRATION: z.string().default('7d'),
    RESET_PASSWORD_TOKEN_EXPIRATION_MINUTES: z.coerce.number().int().positive().default(30),
    REFRESH_TOKEN_COOKIE_NAME: z.string().default('refreshToken'),
    COOKIE_SECURE: z
        .string()
        .optional()
        .transform((value) => value === 'true'),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    // FIREBASE
    CLOUDINARY_API_KEY: z.string().describe('CLOUDINARY Api Key'),
    CLOUDINARY_CLOUD_NAME: z.string().describe('CLOUDINARY cloud name'),
    CLOUDINARY_API_SECRET: z.string().describe('CLOUDINARY api secret'),
    // NODEMAILER
    SMTP_HOST: z.string().default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_SECURE: z
        .string()
        .optional()
        .transform((value) => value === 'true'),
    EMAIL_USER: z.string().email(),
    EMAIL_PASSWORD: z.string().min(3),
    EMAIL_FROM: z.string().optional(),
    EMAIL_FROM_NAME: z.string().default('Device Management System'),
});

const result = envVarsSchema.safeParse(process.env);

if (!result.success) {
    result.error.issues.forEach((issue) => {
        const message =
            issue.message === 'Required' ? VALIDATION_MESSAGES.FIELD_REQUIRED(issue.path.join('.')) : issue.message;
        console.error(`❌ Field "${issue.path.join('.')}" - ${message}`);
    });
    console.error('⛔ Stopping application due to missing environment variables.');
    process.exit(1);
}

const envVars = result.data;
const config = {
    port: envVars.PORT,
    hostname: envVars.APP_HOST,
    app: {
        clientUrl: envVars.CLIENT_URL,
        resetPasswordUrl: envVars.RESET_PASSWORD_URL,
        allowedOrigins: envVars.ALLOWED_ORIGINS ? envVars.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : [],
    },
    mongoose: {
        url: envVars.MONGODB_URL_DEV,
        options: {
            dbName: 'device-management',
        },
        syncIndexes: envVars.SYNC_INDEXES,
    },
    auth: {
        bypass: envVars.AUTH_BYPASS,
        resetPasswordTokenExpirationMinutes: envVars.RESET_PASSWORD_TOKEN_EXPIRATION_MINUTES,
        refreshTokenCookieName: envVars.REFRESH_TOKEN_COOKIE_NAME,
        cookieSecure: envVars.COOKIE_SECURE,
        cookieSameSite: envVars.COOKIE_SAME_SITE,
    },
    jwt: {
        accessTokenKey: envVars.JWT_ACCESS_TOKEN_KEY,
        accessExpiration: envVars.JWT_ACCESS_EXPIRATION as SignOptions['expiresIn'],
        refreshTokenKey: envVars.JWT_REFRESH_TOKEN_KEY || envVars.JWT_VERIFY_TOKEN_KEY,
        refreshExpiration: envVars.JWT_REFRESH_EXPIRATION as SignOptions['expiresIn'],
        verifyTokenKey: envVars.JWT_VERIFY_TOKEN_KEY,
        verifyExpiration: envVars.JWT_VERIFY_EXPIRATION as SignOptions['expiresIn'],
    },
    cloudinaryConfig: {
        cloudName: envVars.CLOUDINARY_CLOUD_NAME,
        apiKey: envVars.CLOUDINARY_API_KEY,
        apiSecret: envVars.CLOUDINARY_API_SECRET,
    },
    nodeMailer: {
        host: envVars.SMTP_HOST,
        port: envVars.SMTP_PORT,
        secure: envVars.SMTP_SECURE,
        email: envVars.EMAIL_USER,
        password: envVars.EMAIL_PASSWORD,
        fromEmail: envVars.EMAIL_FROM || envVars.EMAIL_USER,
        fromName: envVars.EMAIL_FROM_NAME,
    },
};

export default config;
