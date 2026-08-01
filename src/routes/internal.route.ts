import { Router } from 'express';
import config from '@/config/env.config';
import { checkAndNotifyOverdueMaintenance } from '@/services/notification.helper';
import asyncHandler from '@/utils/asyncHandler';
import customResponse from '@/utils/response';
import { StatusCodes } from 'http-status-codes';
import { evaluateAllRealityOperations } from '@/services/reality-operations.service';
import { ensureLatestExecutiveBriefings } from '@/services/executive-briefing.service';
import { evaluateProductionReminders } from '@/services/production-reminder.service';
import type { BriefingPeriodType } from '@/types/executiveBriefing';

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

router.post(
    '/executive-briefing',
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

        const requested = req.body?.period;
        if (requested !== undefined && requested !== 'week' && requested !== 'month') {
            return res.status(StatusCodes.BAD_REQUEST).json(
                customResponse({
                    data: null,
                    message: 'period phai la week hoac month',
                    status: StatusCodes.BAD_REQUEST,
                    success: false,
                })
            );
        }
        const result = await ensureLatestExecutiveBriefings('internal', requested as BriefingPeriodType | undefined);
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: result,
                message: 'Da kiem tra ban tin van hanh',
                status: StatusCodes.OK,
                success: true,
            })
        );
    })
);

const runProductionReminders = asyncHandler(async (req, res) => {
    const secret = req.headers['x-internal-cron-secret'] || (req.query.secret as string | undefined);
    if (!assertInternalSecret(secret)) {
        return res.status(StatusCodes.UNAUTHORIZED).json(
            customResponse({
                data: null,
                message: 'Internal cron secret khong hop le',
                status: StatusCodes.UNAUTHORIZED,
                success: false,
            })
        );
    }
    const result = await evaluateProductionReminders('internal');
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: result,
            message: 'Da kiem tra nhac nhap san luong',
            status: StatusCodes.OK,
            success: true,
        })
    );
});

// POST + header là cách ưu tiên. GET + query secret dành cho monitor miễn phí
// không hỗ trợ custom header; chỉ dùng qua HTTPS và phải xoay secret nếu URL lộ.
router.post('/production-reminders', runProductionReminders);
router.get('/production-reminders', runProductionReminders);

router.post(
    '/reality-operations',
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
        const result = await evaluateAllRealityOperations({ notify: true });
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: result,
                message: 'Da danh gia Reality Operations',
                status: StatusCodes.OK,
                success: true,
            })
        );
    })
);

export default router;
