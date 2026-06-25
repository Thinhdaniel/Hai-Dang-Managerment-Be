import { Router } from 'express';
import config from '@/config/env.config';
import { checkAndNotifyOverdueMaintenance } from '@/services/notification.helper';
import asyncHandler from '@/utils/asyncHandler';
import customResponse from '@/utils/response';
import { StatusCodes } from 'http-status-codes';

const router = Router();

const assertInternalSecret = (secret?: string | string[]) =>
    Boolean(config.internalCron.enabled && secret && String(secret) === config.internalCron.secret);

router.post(
    '/maintenance-overdue',
    asyncHandler(async (req, res) => {
        if (!assertInternalSecret(req.headers['x-internal-cron-secret'])) {
            return res.status(StatusCodes.UNAUTHORIZED).json(
                customResponse({
                    data: null,
                    message: 'Internal cron secret khong hop le',
                    status: StatusCodes.UNAUTHORIZED,
                    success: false,
                })
            );
        }

        const result = await checkAndNotifyOverdueMaintenance();

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: result,
                message: 'Da chay kiem tra bao tri qua han',
                status: StatusCodes.OK,
                success: true,
            })
        );
    })
);

export default router;
