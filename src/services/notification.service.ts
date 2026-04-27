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

    const notifications = [
        ...activeTransactions.map((item) => ({
            id: `borrowing-${item._id}`,
            type: 'borrowing' as const,
            title: 'Giao dich thiet bi dang hoat dong',
            message: `${(item.assetId as any)?.name ?? 'Thiet bi'} dang trong giao dich ${item.type}`,
            assetId: String((item.assetId as any)?._id ?? item.assetId),
            isRead: false,
            createdAt: new Date(item.updatedAt).toISOString(),
        })),
        ...overdueMaintenances.map((item) => ({
            id: `maintenance-${item._id}`,
            type: 'maintenance' as const,
            title: 'Bao tri qua han',
            message: `${(item.assetId as any)?.name ?? 'Thiet bi'} co phieu bao tri qua han`,
            assetId: String((item.assetId as any)?._id ?? item.assetId),
            isRead: false,
            createdAt: new Date(item.updatedAt).toISOString(),
        })),
        ...pendingTransfers.map((item) => ({
            id: `transfer-${item._id}`,
            type: 'transfer' as const,
            title: 'Lenh dieu chuyen cho duyet',
            message: `${(item.assetId as any)?.name ?? 'Thiet bi'} dang cho duyet dieu chuyen`,
            assetId: String((item.assetId as any)?._id ?? item.assetId),
            isRead: false,
            createdAt: new Date(item.updatedAt).toISOString(),
        })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: notifications,
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
