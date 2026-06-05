import config from '@/config/env.config';
import PushSubscription from '@/models/PushSubscription';
import Notification from '@/models/Notification';
import type { INotification } from '@/models/Notification';
import { emitToUser } from '@/lib/socket';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import webPush, { type PushSubscription as WebPushSubscription } from 'web-push';

type SubscribePayload = {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: {
        p256dh?: string;
        auth?: string;
    };
    deviceName?: string;
    platform?: string;
};

type PushSendSummary = {
    enabled: boolean;
    attempted: number;
    sent: number;
    failed: number;
};

const configureWebPush = () => {
    if (!config.webPush.enabled || !config.webPush.publicKey || !config.webPush.privateKey) {
        return false;
    }

    webPush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
    return true;
};

const isConfigured = configureWebPush();

const buildActionUrl = (notification: Pick<INotification, 'actionType' | 'actionId'> | any) => {
    const actionType = String(notification.actionType ?? '').replaceAll('-', '_');
    const actionId = notification.actionId ? String(notification.actionId) : '';

    if (actionType === 'machine' || actionType === 'asset') return `/assets${actionId ? `/${actionId}` : ''}`;
    if (actionType === 'transfer') return '/transfers';
    if (actionType === 'maintenance') return '/maintenances';
    if (actionType === 'borrowing') return '/borrowings';
    if (actionType === 'purchase_request') return '/materials/purchase-requests';
    if (actionType === 'supply_request') return '/materials/supply-requests';
    if (actionType === 'purchase_order') return '/materials/purchase-orders';
    if (actionType === 'distribution') return '/materials/distributions';

    return '/dashboard';
};

const toWebPushSubscription = (subscription: {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
}): WebPushSubscription => ({
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
    },
});

const getNotificationPayload = (notification: INotification | any) =>
    JSON.stringify({
        notificationId: String(notification._id ?? ''),
        title: notification.title ?? 'Thông báo mới',
        body: notification.message ?? '',
        type: notification.type ?? 'info',
        actionType: notification.actionType ?? 'system',
        actionId: notification.actionId,
        url: buildActionUrl(notification),
        tag: `${notification.actionType ?? 'system'}:${notification.actionId ?? notification._id ?? Date.now()}`,
        createdAt: notification.createdAt ?? new Date().toISOString(),
    });

export const getPublicKey = async (_req: Request, res: Response, _next: NextFunction) => {
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                enabled: isConfigured,
                publicKey: config.webPush.publicKey ?? '',
            },
            message: 'Lay cau hinh web push thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getStatus = async (req: Request, res: Response, _next: NextFunction) => {
    const activeDevices = await PushSubscription.countDocuments({
        userId: req.userId,
        isActive: true,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                enabled: isConfigured,
                activeDevices,
            },
            message: 'Lay trang thai web push thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const subscribe = async (req: Request, res: Response, _next: NextFunction) => {
    if (!isConfigured) {
        return res.status(StatusCodes.BAD_REQUEST).json(
            customResponse({
                data: null,
                message: 'Web Push chua duoc cau hinh tren server',
                status: StatusCodes.BAD_REQUEST,
                success: false,
            })
        );
    }

    const payload = req.body as SubscribePayload;
    const endpoint = payload.endpoint?.trim();
    const p256dh = payload.keys?.p256dh?.trim();
    const auth = payload.keys?.auth?.trim();

    if (!endpoint || !p256dh || !auth) {
        return res.status(StatusCodes.BAD_REQUEST).json(
            customResponse({
                data: null,
                message: 'Thieu thong tin subscription',
                status: StatusCodes.BAD_REQUEST,
                success: false,
            })
        );
    }

    const subscription = await PushSubscription.findOneAndUpdate(
        { endpoint },
        {
            $set: {
                userId: req.userId,
                endpoint,
                expirationTime: payload.expirationTime ?? null,
                keys: { p256dh, auth },
                deviceName: payload.deviceName,
                platform: payload.platform,
                userAgent: req.headers['user-agent'] ?? '',
                isActive: true,
                lastSeenAt: new Date(),
                failureCount: 0,
                revokedAt: null,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                id: subscription._id,
                activeDevices: await PushSubscription.countDocuments({ userId: req.userId, isActive: true }),
            },
            message: 'Da bat thong bao tren thiet bi nay',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const unsubscribe = async (req: Request, res: Response, _next: NextFunction) => {
    const endpoint = String(req.body?.endpoint ?? '').trim();
    const filter = endpoint ? { userId: req.userId, endpoint } : { userId: req.userId, isActive: true };

    await PushSubscription.updateMany(filter, {
        $set: {
            isActive: false,
            revokedAt: new Date(),
        },
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                activeDevices: await PushSubscription.countDocuments({ userId: req.userId, isActive: true }),
            },
            message: 'Da tat thong bao tren thiet bi',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const sendTestNotification = async (req: Request, res: Response, _next: NextFunction) => {
    const notification = await Notification.create({
        userId: req.userId,
        title: 'Thông báo thử nghiệm',
        message: 'Thiết bị này đã sẵn sàng nhận thông báo khi bạn không mở hệ thống.',
        type: 'success',
        actionType: 'system',
        isRead: false,
    });

    const payload = notification.toObject();
    emitToUser(String(req.userId), 'notify:new', payload);
    const delivery = await sendWebPushToUser(String(req.userId), payload);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                notification: payload,
                delivery,
            },
            message: 'Da gui thong bao thu nghiem',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const sendWebPushToUser = async (
    userId: string,
    notification: INotification | any
): Promise<PushSendSummary> => {
    if (!isConfigured) {
        return { enabled: false, attempted: 0, sent: 0, failed: 0 };
    }

    const subscriptions = await PushSubscription.find({ userId, isActive: true }).lean();
    const payload = getNotificationPayload(notification);
    let sent = 0;
    let failed = 0;

    await Promise.all(
        subscriptions.map(async (subscription) => {
            try {
                await webPush.sendNotification(toWebPushSubscription(subscription), payload, {
                    TTL: 60 * 60 * 24,
                    urgency: notification.type === 'error' || notification.type === 'warning' ? 'high' : 'normal',
                });
                sent += 1;
                await PushSubscription.updateOne(
                    { _id: subscription._id },
                    { $set: { lastSeenAt: new Date(), failureCount: 0 } }
                );
            } catch (error: any) {
                failed += 1;
                const statusCode = Number(error?.statusCode ?? error?.status);
                const shouldDeactivate = statusCode === 404 || statusCode === 410;

                await PushSubscription.updateOne(
                    { _id: subscription._id },
                    {
                        $set: shouldDeactivate
                            ? { isActive: false, revokedAt: new Date() }
                            : { lastSeenAt: new Date() },
                        $inc: { failureCount: 1 },
                    }
                );
                console.error('[WebPush] Failed to send notification:', error?.message ?? error);
            }
        })
    );

    return {
        enabled: true,
        attempted: subscriptions.length,
        sent,
        failed,
    };
};
