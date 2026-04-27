import config from '@/config/env.config';

export const allowedOrigins = Array.from(
    new Set(
        [
            'http://localhost:5173',
            'http://localhost:3000',
            'http://localhost',
            'http://localhost:80',
            'http://34.229.217.0',
            'https://hai-dang-managerment-be.onrender.com',
            'https://hai-dang-managerment-olg04nk85-hieutvph46786s-projects.vercel.app',
            'https://hai-dang-managerment-fe.vercel.app/',
            config.app.clientUrl,
        ].filter(Boolean)
    )
);
