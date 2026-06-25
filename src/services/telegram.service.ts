import config from '@/config/env.config';
import TelegramDeliveryLog from '@/models/TelegramDeliveryLog';
import TelegramLinkToken from '@/models/TelegramLinkToken';
import User from '@/models/User';
import type { INotification } from '@/models/Notification';
import { buildActionUrl } from '@/services/web-push.service';
import customResponse from '@/utils/response';
import { createHash, randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';

type TelegramSendSummary = {
    enabled: boolean;
    linked: boolean;
    attempted: number;
    sent: number;
    failed: number;
};

const LINK_TTL_MS = 10 * 60 * 1000;

const isConfigured = () => Boolean(config.telegram.enabled && config.telegram.botToken && config.telegram.botUsername);

const makeToken = () =>
    randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const getChatIdTail = (chatId?: string | null) => (chatId ? chatId.slice(-10) : undefined);

const telegramApi = async <T = any>(method: string, body: Record<string, unknown>) => {
    if (!config.telegram.botToken) {
        const error = new Error('Telegram bot is not configured') as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
    }

    const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as any;

    if (!response.ok || data?.ok === false) {
        const error = new Error(data?.description || `Telegram ${method} failed`) as Error & {
            statusCode?: number;
        };
        error.statusCode = response.status;
        throw error;
    }

    return data as T;
};

const sendTelegramText = (chatId: string, text: string, url?: string) =>
    telegramApi('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 3900),
        disable_web_page_preview: true,
        ...(url
            ? {
                  reply_markup: {
                      inline_keyboard: [[{ text: 'Mở chi tiết', url }]],
                  },
              }
            : {}),
    });

const getAbsoluteActionUrl = (notification: INotification | any) =>
    new URL(buildActionUrl(notification), config.app.clientUrl).toString();

const buildTelegramText = (notification: INotification | any) => {
    const title = String(notification.title || 'Thông báo mới').trim();
    const message = String(notification.message || '').trim();
    return [`🔔 ${title}`, message].filter(Boolean).join('\n\n');
};

export const getTelegramStatus = async (req: Request, res: Response, _next: NextFunction) => {
    const user = await User.findById(req.userId)
        .select('telegramChatId telegramUsername telegramFirstName telegramLinkedAt telegramDisabledAt')
        .lean();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                enabled: isConfigured(),
                linked: Boolean(user?.telegramChatId),
                botUsername: config.telegram.botUsername,
                telegramUsername: user?.telegramUsername,
                telegramFirstName: user?.telegramFirstName,
                linkedAt: user?.telegramLinkedAt,
                disabledAt: user?.telegramDisabledAt,
            },
            message: 'Lay trang thai Telegram thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createTelegramLink = async (req: Request, res: Response, _next: NextFunction) => {
    if (!isConfigured()) {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    enabled: false,
                    linked: false,
                },
                message: 'Telegram chua duoc cau hinh tren server',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const now = new Date();
    const token = makeToken();
    const expiresAt = new Date(now.getTime() + LINK_TTL_MS);

    await TelegramLinkToken.deleteMany({
        $or: [{ expiresAt: { $lte: now } }, { userId: req.userId, usedAt: { $ne: null } }],
    });

    await TelegramLinkToken.updateMany(
        {
            userId: req.userId,
            usedAt: null,
            expiresAt: { $gt: now },
        },
        { $set: { usedAt: now } }
    );

    await TelegramLinkToken.create({
        userId: req.userId,
        tokenHash: hashToken(token),
        expiresAt,
    });

    const deepLink = `https://t.me/${config.telegram.botUsername}?start=${encodeURIComponent(token)}`;
    const user = await User.findById(req.userId).select('telegramChatId').lean();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                enabled: true,
                linked: Boolean(user?.telegramChatId),
                botUsername: config.telegram.botUsername,
                deepLink,
                expiresAt,
            },
            message: 'Da tao link ket noi Telegram',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const unlinkTelegram = async (req: Request, res: Response, _next: NextFunction) => {
    await User.findByIdAndUpdate(req.userId, {
        $set: {
            telegramChatId: null,
            telegramUsername: null,
            telegramFirstName: null,
            telegramLinkedAt: null,
            telegramDisabledAt: null,
            telegramLastError: null,
        },
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Da ngat ket noi Telegram',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const handleTelegramWebhook = async (req: Request, res: Response, _next: NextFunction) => {
    if (config.telegram.webhookSecret) {
        const secret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
        if (secret !== config.telegram.webhookSecret) {
            return res.status(StatusCodes.UNAUTHORIZED).json({ ok: false });
        }
    }

    const message = req.body?.message;
    const text = String(message?.text || '').trim();
    const chat = message?.chat;
    const chatId = chat?.id ? String(chat.id) : '';

    if (!chatId || !text.startsWith('/start')) {
        return res.status(StatusCodes.OK).json({ ok: true });
    }

    const [, token = ''] = text.match(/^\/start(?:\s+(.+))?$/) || [];
    const tokenHash = token ? hashToken(token.trim()) : '';

    const link = tokenHash
        ? await TelegramLinkToken.findOne({
              tokenHash,
              usedAt: null,
              expiresAt: { $gt: new Date() },
          })
        : null;

    if (!link) {
        await sendTelegramText(
            chatId,
            'Link kết nối đã hết hạn hoặc không hợp lệ. Hãy quay lại Hải Đăng MS và bấm Kết nối Telegram lần nữa.'
        ).catch(() => undefined);
        return res.status(StatusCodes.OK).json({ ok: true });
    }

    await User.findByIdAndUpdate(link.userId, {
        $set: {
            telegramChatId: chatId,
            telegramUsername: chat?.username || null,
            telegramFirstName: chat?.first_name || null,
            telegramLinkedAt: new Date(),
            telegramDisabledAt: null,
            telegramLastError: null,
        },
    });

    await TelegramLinkToken.updateOne({ _id: link._id }, { $set: { usedAt: new Date(), chatId } });
    await sendTelegramText(
        chatId,
        'Đã kết nối Telegram với Hải Đăng MS. Từ giờ các thông báo quan trọng có thể được gửi tới đây khi Web Push không ổn định.'
    ).catch(() => undefined);

    return res.status(StatusCodes.OK).json({ ok: true });
};

export const sendTelegramToUser = async (
    userId: string,
    notification: INotification | any
): Promise<TelegramSendSummary> => {
    if (!isConfigured()) {
        return { enabled: false, linked: false, attempted: 0, sent: 0, failed: 0 };
    }

    const user = await User.findById(userId)
        .select('telegramChatId telegramDisabledAt telegramLastError')
        .lean();
    if (!user?.telegramChatId || user.telegramDisabledAt) {
        return { enabled: true, linked: Boolean(user?.telegramChatId), attempted: 0, sent: 0, failed: 0 };
    }

    const attemptedAt = new Date();
    try {
        await sendTelegramText(user.telegramChatId, buildTelegramText(notification), getAbsoluteActionUrl(notification));
        const completedAt = new Date();
        await TelegramDeliveryLog.create({
            userId: new mongoose.Types.ObjectId(userId),
            notificationId: notification._id ? new mongoose.Types.ObjectId(String(notification._id)) : null,
            chatIdTail: getChatIdTail(user.telegramChatId),
            status: 'sent',
            attemptedAt,
            completedAt,
        });
        return { enabled: true, linked: true, attempted: 1, sent: 1, failed: 0 };
    } catch (error: any) {
        const completedAt = new Date();
        const statusCode = Number(error?.statusCode ?? error?.status);
        const errorMessage = String(error?.message ?? error).slice(0, 500);

        if (statusCode === 400 || statusCode === 403) {
            await User.findByIdAndUpdate(userId, {
                $set: {
                    telegramDisabledAt: completedAt,
                    telegramLastError: errorMessage,
                },
            });
        }

        await TelegramDeliveryLog.create({
            userId: new mongoose.Types.ObjectId(userId),
            notificationId: notification._id ? new mongoose.Types.ObjectId(String(notification._id)) : null,
            chatIdTail: getChatIdTail(user.telegramChatId),
            status: 'failed',
            statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
            errorMessage,
            attemptedAt,
            completedAt,
        });
        console.error('[Telegram] Failed to send notification:', errorMessage);
        return { enabled: true, linked: true, attempted: 1, sent: 0, failed: 1 };
    }
};
