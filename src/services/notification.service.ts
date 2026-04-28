import Borrowing from '@/models/Borrowing';
import Maintenance from '@/models/Maintenance';
import Transfer from '@/models/Transfer';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

export const getNotifications = async (req: Request, res: Response, next: NextFunction) => {
    const [activeTransactions, overdueMaintenances, pendingTransfers] = await Promise.all([
        Borrowing.find({
            isDeleted: { $ne: true },
            status: 'active',
        })
            .populate('assetId')
            .sort('-updatedAt')
            .limit(10),
        Maintenance.find({
            isDeleted: { $ne: true },
            status: 'overdue',
        })
            .populate('assetId')
            .sort('-updatedAt')
            .limit(10),
        Transfer.find({
            isDeleted: { $ne: true },
            status: 'pending',
        })
            .populate('assetId')
            .sort('-updatedAt')
            .limit(10),
    ]);

    // Format notifications to match frontend's Notification interface
    const notifications = [
        ...activeTransactions.map((item) => ({
            _id: `borrowing-${item._id}`,
            userId: '',
            type: 'info' as const,
            actionType: 'borrowing' as const,
            actionId: String(item._id),
            title: 'Giao dịch thiết bị đang hoạt động',
            message: `${(item.assetId as any)?.name ?? 'Thiết bị'} đang trong giao dịch ${item.type}`,
            isRead: false,
            createdAt: new Date(item.updatedAt).toISOString(),
        })),
        ...overdueMaintenances.map((item) => ({
            _id: `maintenance-${item._id}`,
            userId: '',
            type: 'warning' as const,
            actionType: 'maintenance' as const,
            actionId: String(item._id),
            title: 'Bảo trì quá hạn',
            message: `${(item.assetId as any)?.name ?? 'Thiết bị'} có phiếu bảo trì quá hạn`,
            isRead: false,
            createdAt: new Date(item.updatedAt).toISOString(),
        })),
        ...pendingTransfers.map((item) => ({
            _id: `transfer-${item._id}`,
            userId: '',
            type: 'warning' as const,
            actionType: 'transfer' as const,
            actionId: String(item._id),
            title: 'Lệnh điều chuyển chờ duyệt',
            message: `${(item.assetId as any)?.name ?? 'Thiết bị'} đang chờ duyệt điều chuyển`,
            isRead: false,
            createdAt: new Date(item.updatedAt).toISOString(),
        })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                notifications,
                total: notifications.length,
                unreadCount: notifications.filter(n => !n.isRead).length,
            },
            message: 'Lay thong bao thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const markNotificationAsRead = async (req: Request, res: Response, next: NextFunction) => {
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
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Da danh dau tat ca la da doc',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
