import { VALIDATION_MESSAGES } from '@/constant/messages';
import { DEFAULT_FEATURE_MODELS } from '@/constant/aiModels';
import 'dotenv/config';
import { SignOptions } from 'jsonwebtoken';
import z from 'zod';

const envVarsSchema = z.object({
    // SERVER
    PORT: z.coerce.number().default(8000),
    APP_HOST: z.string().default('0.0.0.0'),
    CLIENT_URL: z.string().default('http://localhost:5173'),
    RESET_PASSWORD_URL: z
        .string()
        .optional()
        .describe('Custom URL for password reset page (e.g., https://yourdomain.com/reset-password)'),
    ALLOWED_ORIGINS: z.string().optional().describe('Comma-separated list of allowed CORS origins'),
    MONGODB_URL_DEV: z.string().describe('Local Mongo DB'),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    MONGODB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    MONGODB_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
    // Pool/keep-alive — chong socket Atlas bi NAT cat lam treo request dau tien
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(10),
    MONGODB_MIN_POOL_SIZE: z.coerce.number().int().nonnegative().default(2),
    MONGODB_MAX_IDLE_TIME_MS: z.coerce.number().int().positive().default(30000),
    MONGODB_HEARTBEAT_FREQUENCY_MS: z.coerce.number().int().positive().default(10000),
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
    // WEB PUSH
    WEB_PUSH_PUBLIC_KEY: z.string().optional(),
    WEB_PUSH_PRIVATE_KEY: z.string().optional(),
    WEB_PUSH_SUBJECT: z.string().optional(),
    // TELEGRAM NOTIFICATION FALLBACK
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_USERNAME: z.string().optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
    // INTERNAL CRON WAKE-UP
    INTERNAL_CRON_SECRET: z.string().optional(),
    // AI PROVIDER
    AI_ENABLED: z
        .string()
        .optional()
        .transform((value) => value !== 'false'),
    AI_PROVIDER: z.enum(['ollama', '9router', 'openrouter', 'disabled']).default('ollama'),
    AI_BASE_URL: z.string().optional(),
    AI_API_KEY: z.string().optional(),
    AI_MODEL_DEFAULT: z.string().optional(),
    AI_MODEL_JSON: z.string().optional(),
    // Map model theo từng tác vụ AI (JSON). Vd: {"material-match":"oc/deepseek-v4-flash-free","asset-search":"oc/nemotron-3-ultra-free"}
    AI_FEATURE_MODELS: z.string().optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    OLLAMA_BASE_URL: z.string().optional(),
    OLLAMA_MODEL: z.string().optional(),
    OLLAMA_SEARCH_MODEL: z.string().optional(),
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    OLLAMA_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL_DEFAULT: z.string().optional(),
    OPENROUTER_MODEL_JSON: z.string().optional(),
    OPENROUTER_HTTP_REFERER: z.string().optional(),
    OPENROUTER_APP_TITLE: z.string().optional(),
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

// Parse map model theo tác vụ AI (feature -> model). Sai JSON thì bỏ qua, không làm chết app.
const parseFeatureModels = (raw?: string): Record<string, string> => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.fromEntries(
                Object.entries(parsed)
                    .filter(([, v]) => typeof v === 'string' && v)
                    .map(([k, v]) => [k, String(v)])
            );
        }
        return {};
    } catch {
        console.warn('⚠️ AI_FEATURE_MODELS không phải JSON hợp lệ — bỏ qua, dùng model mặc định.');
        return {};
    }
};

const config = {
    port: envVars.PORT,
    hostname: envVars.APP_HOST,
    app: {
        clientUrl: envVars.CLIENT_URL,
        resetPasswordUrl: envVars.RESET_PASSWORD_URL,
        allowedOrigins: envVars.ALLOWED_ORIGINS ? envVars.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : [],
    },
    mongoose: {
        url: envVars.MONGODB_URL_DEV,
        options: {
            dbName: 'device-management',
            serverSelectionTimeoutMS: envVars.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
            connectTimeoutMS: envVars.MONGODB_CONNECT_TIMEOUT_MS,
            socketTimeoutMS: envVars.MONGODB_SOCKET_TIMEOUT_MS,
            maxPoolSize: envVars.MONGODB_MAX_POOL_SIZE,
            minPoolSize: envVars.MONGODB_MIN_POOL_SIZE,
            maxIdleTimeMS: envVars.MONGODB_MAX_IDLE_TIME_MS,
            heartbeatFrequencyMS: envVars.MONGODB_HEARTBEAT_FREQUENCY_MS,
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
    webPush: {
        publicKey: envVars.WEB_PUSH_PUBLIC_KEY,
        privateKey: envVars.WEB_PUSH_PRIVATE_KEY,
        subject: envVars.WEB_PUSH_SUBJECT || `mailto:${envVars.EMAIL_FROM || envVars.EMAIL_USER}`,
        enabled: Boolean(envVars.WEB_PUSH_PUBLIC_KEY && envVars.WEB_PUSH_PRIVATE_KEY),
    },
    telegram: {
        botToken: envVars.TELEGRAM_BOT_TOKEN,
        botUsername: envVars.TELEGRAM_BOT_USERNAME?.replace(/^@/, ''),
        webhookSecret: envVars.TELEGRAM_WEBHOOK_SECRET,
        enabled: Boolean(envVars.TELEGRAM_BOT_TOKEN && envVars.TELEGRAM_BOT_USERNAME),
    },
    internalCron: {
        secret: envVars.INTERNAL_CRON_SECRET,
        enabled: Boolean(envVars.INTERNAL_CRON_SECRET),
    },
    ai: {
        enabled: envVars.AI_ENABLED,
        provider: envVars.AI_PROVIDER,
        baseUrl: envVars.AI_BASE_URL,
        apiKey: envVars.AI_API_KEY,
        defaultModel: envVars.AI_MODEL_DEFAULT,
        jsonModel: envVars.AI_MODEL_JSON,
        // Default mạnh nhúng trong code làm nền; env AI_FEATURE_MODELS đè lên để tinh chỉnh.
        featureModels: { ...DEFAULT_FEATURE_MODELS, ...parseFeatureModels(envVars.AI_FEATURE_MODELS) },
        timeoutMs: envVars.AI_TIMEOUT_MS,
        ollama: {
            baseUrl: envVars.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
            defaultModel: envVars.OLLAMA_MODEL || envVars.AI_MODEL_DEFAULT || 'qwen2.5:3b',
            searchModel: envVars.OLLAMA_SEARCH_MODEL || envVars.AI_MODEL_JSON || 'qwen2.5:7b',
            timeoutMs: envVars.OLLAMA_TIMEOUT_MS || envVars.AI_TIMEOUT_MS,
            searchTimeoutMs: envVars.OLLAMA_SEARCH_TIMEOUT_MS || envVars.OLLAMA_TIMEOUT_MS || envVars.AI_TIMEOUT_MS,
        },
        openRouter: {
            apiKey: envVars.OPENROUTER_API_KEY || envVars.AI_API_KEY,
            defaultModel: envVars.OPENROUTER_MODEL_DEFAULT || envVars.AI_MODEL_DEFAULT,
            jsonModel: envVars.OPENROUTER_MODEL_JSON || envVars.AI_MODEL_JSON,
            httpReferer: envVars.OPENROUTER_HTTP_REFERER || envVars.CLIENT_URL,
            appTitle: envVars.OPENROUTER_APP_TITLE || 'Hai Dang Management',
        },
    },
};

export default config;
