import config from '@/config/env.config';
import PushDeliveryLog from '@/models/PushDeliveryLog';
import PushSubscription from '@/models/PushSubscription';
import Notification from '@/models/Notification';
import type { INotification } from '@/models/Notification';
import { emitToUser } from '@/lib/socket';
import { sendTelegramToUser } from '@/services/telegram.service';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
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
    trusted?: boolean;
};

type PushSendSummary = {
    enabled: boolean;
    attempted: number;
    sent: number;
    failed: number;
};

const DETAILED_PUSH_TRUST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const configureWebPush = () => {
    if (!config.webPush.enabled || !config.webPush.publicKey || !config.webPush.privateKey) {
        return false;
    }

    webPush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
    return true;
};

const isConfigured = configureWebPush();

export const buildActionUrl = (notification: Pick<INotification, 'actionType' | 'actionId'> | any) => {
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
    if (actionType === 'chat') return `/chat${actionId ? `?conversation=${encodeURIComponent(actionId)}` : ''}`;

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

const getEndpointTail = (endpoint?: string) => (endpoint ? endpoint.slice(-12) : undefined);

const isDetailedPushAllowed = (subscription: any) => {
    if (subscription.trusted === false) return false;

    const confirmedAt = subscription.lastConfirmedAt || subscription.lastSeenAt || subscription.updatedAt;
    if (!confirmedAt) return false;

    return Date.now() - new Date(confirmedAt).getTime() <= DETAILED_PUSH_TRUST_WINDOW_MS;
};

const getNotificationPayload = (notification: INotification | any, unreadCount: number, detailed: boolean) => {
    const notificationId = String(notification._id ?? '');
    const tag = `${notification.actionType ?? 'system'}:${notification.actionId ?? notification._id ?? Date.now()}`;

    if (!detailed) {
        return JSON.stringify({
            notificationId,
            title: 'Thông báo mới từ Hải Đăng',
            body: 'Bạn có thông báo mới cần xem trong hệ thống.',
            type: notification.type ?? 'info',
            actionType: 'system',
            url: '/dashboard',
            tag,
            createdAt: notification.createdAt ?? new Date().toISOString(),
            unreadCount,
            redacted: true,
        });
    }

    return JSON.stringify({
        notificationId,
        title: notification.title ?? 'Thông báo mới',
        body: notification.message ?? '',
        type: notification.type ?? 'info',
        actionType: notification.actionType ?? 'system',
        actionId: notification.actionId,
        url: buildActionUrl(notification),
        tag,
        createdAt: notification.createdAt ?? new Date().toISOString(),
        unreadCount,
        redacted: false,
    });
};

const serializeDevice = (subscription: any) => ({
    id: String(subscription._id),
    deviceName: subscription.deviceName || 'Thiết bị chưa đặt tên',
    platform: subscription.platform || '',
    userAgent: subscription.userAgent || '',
    endpointTail: getEndpointTail(subscription.endpoint),
    trusted: subscription.trusted !== false,
    isActive: subscription.isActive !== false,
    lastSeenAt: subscription.lastSeenAt,
    lastConfirmedAt: subscription.lastConfirmedAt,
    lastSentAt: subscription.lastSentAt,
    lastSuccessAt: subscription.lastSuccessAt,
    lastFailureAt: subscription.lastFailureAt,
    failureCount: subscription.failureCount || 0,
    revokedAt: subscription.revokedAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
});

const getCurrentDeviceName = (payload: SubscribePayload, req: Request) =>
    payload.deviceName ||
    [
        payload.platform || req.headers['sec-ch-ua-platform'],
        /Mobile/i.test(String(req.headers['user-agent'] ?? '')) ? 'Mobile' : 'Desktop',
    ]
        .filter(Boolean)
        .join(' · ');

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

export const getDevices = async (req: Request, res: Response, _next: NextFunction) => {
    const devices = await PushSubscription.find({ userId: req.userId }).sort({ isActive: -1, updatedAt: -1 }).limit(50);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: devices.map(serializeDevice),
            message: 'Lay danh sach thiet bi nhan thong bao thanh cong',
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
    const now = new Date();

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
                deviceName: getCurrentDeviceName(payload, req),
                platform: payload.platform,
                userAgent: req.headers['user-agent'] ?? '',
                trusted: payload.trusted !== false,
                isActive: true,
                lastSeenAt: now,
                lastConfirmedAt: now,
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

export const syncDevice = async (req: Request, res: Response, _next: NextFunction) => {
    const payload = req.body as SubscribePayload;
    const endpoint = payload.endpoint?.trim();
    const p256dh = payload.keys?.p256dh?.trim();
    const auth = payload.keys?.auth?.trim();
    const now = new Date();

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
                deviceName: getCurrentDeviceName(payload, req),
                platform: payload.platform,
                userAgent: req.headers['user-agent'] ?? '',
                isActive: true,
                lastSeenAt: now,
                lastConfirmedAt: now,
                failureCount: 0,
                revokedAt: null,
            },
            $setOnInsert: {
                trusted: payload.trusted !== false,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                device: serializeDevice(subscription),
                activeDevices: await PushSubscription.countDocuments({ userId: req.userId, isActive: true }),
            },
            message: 'Da dong bo thiet bi nhan thong bao',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const unsubscribe = async (req: Request, res: Response, _next: NextFunction) => {
    const endpoint = String(req.body?.endpoint ?? '').trim();

    if (!endpoint) {
        return res.status(StatusCodes.BAD_REQUEST).json(
            customResponse({
                data: null,
                message: 'Thieu endpoint thiet bi can tat thong bao',
                status: StatusCodes.BAD_REQUEST,
                success: false,
            })
        );
    }

    await PushSubscription.updateMany(
        { userId: req.userId, endpoint },
        {
            $set: {
                isActive: false,
                trusted: false,
                revokedAt: new Date(),
            },
        }
    );

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

export const updateDevice = async (req: Request, res: Response, _next: NextFunction) => {
    const deviceId = req.params.id;
    const update: Record<string, unknown> = {};

    if (typeof req.body?.deviceName === 'string') {
        update.deviceName = req.body.deviceName.trim() || 'Thiết bị chưa đặt tên';
    }

    if (typeof req.body?.trusted === 'boolean') {
        update.trusted = req.body.trusted;
        if (req.body.trusted) {
            update.lastConfirmedAt = new Date();
        }
    }

    const device = await PushSubscription.findOneAndUpdate(
        { _id: deviceId, userId: req.userId },
        { $set: update },
        { new: true }
    );

    if (!device) {
        return res.status(StatusCodes.NOT_FOUND).json(
            customResponse({
                data: null,
                message: 'Khong tim thay thiet bi',
                status: StatusCodes.NOT_FOUND,
                success: false,
            })
        );
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeDevice(device),
            message: 'Da cap nhat thiet bi nhan thong bao',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deactivateDevice = async (req: Request, res: Response, _next: NextFunction) => {
    const device = await PushSubscription.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        {
            $set: {
                isActive: false,
                trusted: false,
                revokedAt: new Date(),
            },
        },
        { new: true }
    );

    if (!device) {
        return res.status(StatusCodes.NOT_FOUND).json(
            customResponse({
                data: null,
                message: 'Khong tim thay thiet bi',
                status: StatusCodes.NOT_FOUND,
                success: false,
            })
        );
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                device: serializeDevice(device),
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
    const telegramDelivery = await sendTelegramToUser(String(req.userId), payload);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                notification: payload,
                delivery,
                telegramDelivery,
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
    const unreadCount = await Notification.countDocuments({ userId, isRead: false });
    let sent = 0;
    let failed = 0;

    await Promise.all(
        subscriptions.map(async (subscription) => {
            const detailed = isDetailedPushAllowed(subscription);
            const payload = getNotificationPayload(notification, unreadCount, detailed);
            const attemptedAt = new Date();
            try {
                await webPush.sendNotification(toWebPushSubscription(subscription), payload, {
                    TTL: 60 * 60 * 24,
                    urgency: notification.type === 'error' || notification.type === 'warning' ? 'high' : 'normal',
                });
                sent += 1;
                const completedAt = new Date();
                await PushSubscription.updateOne(
                    { _id: subscription._id },
                    {
                        $set: {
                            lastSeenAt: completedAt,
                            lastSentAt: attemptedAt,
                            lastSuccessAt: completedAt,
                            failureCount: 0,
                        },
                    }
                );
                await PushDeliveryLog.create({
                    userId: new mongoose.Types.ObjectId(userId),
                    notificationId: notification._id ? new mongoose.Types.ObjectId(String(notification._id)) : null,
                    pushSubscriptionId: subscription._id,
                    endpointTail: getEndpointTail(subscription.endpoint),
                    deviceName: subscription.deviceName,
                    platform: subscription.platform,
                    status: 'sent',
                    detailed,
                    attemptedAt,
                    completedAt,
                });
            } catch (error: any) {
                failed += 1;
                const completedAt = new Date();
                const statusCode = Number(error?.statusCode ?? error?.status);
                const shouldDeactivate = statusCode === 404 || statusCode === 410;

                await PushSubscription.updateOne(
                    { _id: subscription._id },
                    {
                        $set: shouldDeactivate
                            ? {
                                  isActive: false,
                                  trusted: false,
                                  revokedAt: completedAt,
                                  lastSentAt: attemptedAt,
                                  lastFailureAt: completedAt,
                              }
                            : { lastSeenAt: completedAt, lastSentAt: attemptedAt, lastFailureAt: completedAt },
                        $inc: { failureCount: 1 },
                    }
                );
                await PushDeliveryLog.create({
                    userId: new mongoose.Types.ObjectId(userId),
                    notificationId: notification._id ? new mongoose.Types.ObjectId(String(notification._id)) : null,
                    pushSubscriptionId: subscription._id,
                    endpointTail: getEndpointTail(subscription.endpoint),
                    deviceName: subscription.deviceName,
                    platform: subscription.platform,
                    status: 'failed',
                    detailed,
                    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
                    errorMessage: String(error?.message ?? error).slice(0, 500),
                    attemptedAt,
                    completedAt,
                });
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
