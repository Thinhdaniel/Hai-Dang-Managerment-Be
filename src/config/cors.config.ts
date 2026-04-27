import { SYSTEM_MESSAGES } from '@/constant/messages';
import { allowedOrigins } from '@/constant/allowOrigins';

export const corsOptions = {
    origin: (origin: any, callback: any) => {
        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error(SYSTEM_MESSAGES.CORS_ERROR));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200,
};
