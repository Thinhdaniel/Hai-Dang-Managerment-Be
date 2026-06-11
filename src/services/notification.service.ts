import Notification from '@/models/Notification';
import { emitToUser } from '@/lib/socket';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

export const getNotifications = async (req: Request, res: Response, next: NextFunction) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.userId;

    const [notifications, unreadCount, total] = await Promise.all([
        Notification.find({ userId }).sort({ createdAt: -1 }).skip(offset).limit(limit),
        Notification.countDocuments({ userId, isRead: false }),
        Notification.countDocuments({ userId }),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                notifications,
                total,
                unreadCount,
            },
            message: 'Lay thong bao thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const markNotificationAsRead = async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const userId = req.userId;

    await Notification.findOneAndUpdate({ _id: id, userId }, { isRead: true, readAt: new Date() });

    // Đồng bộ trạng thái "đã đọc" tới các thiết bị/tab khác của cùng người dùng
    if (userId) {
        emitToUser(String(userId), 'notify:read', { notificationId: id });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Da danh dau da doc',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const markAllNotificationsAsRead = async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.userId;

    await Notification.updateMany({ userId, isRead: false }, { isRead: true, readAt: new Date() });

    if (userId) {
        emitToUser(String(userId), 'notify:read-all', {});
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Da danh dau tat ca la da doc',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteNotification = async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const userId = req.userId;

    await Notification.findOneAndDelete({ _id: id, userId });

    if (userId) {
        emitToUser(String(userId), 'notify:deleted', { notificationId: id });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Da xoa thong bao',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteAllNotifications = async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.userId;

    await Notification.deleteMany({ userId });

    if (userId) {
        emitToUser(String(userId), 'notify:cleared', {});
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Da xoa tat ca thong bao',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
