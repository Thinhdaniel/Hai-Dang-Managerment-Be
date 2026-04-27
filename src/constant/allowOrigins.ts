import config from '@/config/env.config';

export const allowedOrigins = Array.from(
    new Set(
        [
            'http://localhost:5173',
            'http://localhost:3000',
            'http://localhost',
            'http://localhost:80',
            'http://34.229.217.0',
            config.app.clientUrl,
        ].filter(Boolean)
    )
);
