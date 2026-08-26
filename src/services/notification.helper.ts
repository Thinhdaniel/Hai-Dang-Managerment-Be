import { emitToUser } from '@/lib/socket';
import User from '@/models/User';
import Maintenance from '@/models/Maintenance';
import Notification from '@/models/Notification';
import { ROLE_GROUPS } from '@/constant/permissions';
import { sendWebPushToUser } from '@/services/web-push.service';
import { sendTelegramToUser } from '@/services/telegram.service';
import type { WebPushSendOptions } from '@/services/web-push.service';

/**
 * Get actor display name by userId
 * Returns fullname if found, fallback to 'Hệ thống'
 */
export const getActorName = async (userId?: string | null): Promise<string> => {
    if (!userId) return 'Hệ thống';
    try {
        const user = await User.findById(userId).select('fullname username').lean();
        if (!user) return 'Người dùng';
        return (user.fullname as string) || (user.username as string) || 'Người dùng';
    } catch {
        return 'Người dùng';
    }
};

type NotifyOptions = {
    /** Người dùng KHÔNG nhận (vd: chính người vừa thao tác, hoặc người đã được notifyUser riêng). */
    excludeUserIds?: (string | null | undefined)[];
};

export type NotificationDeliverySummary = {
    inAppCreated: number;
    webPushSent: number;
    telegramSent: number;
    failedChannels: number;
};

type UpsertedNotifyOptions = {
    dedupeKey: string;
    deliveryTag: string;
    webPush?: WebPushSendOptions;
    telegramMode?: 'off' | 'fallback' | 'always';
};

/**
 * Gửi thông báo cho cấp quản lý: Super Admin + Giám đốc + Quản lý.
 * Tự khử trùng theo excludeUserIds (thường truyền người thao tác để không tự báo cho mình).
 */
export const notifyAdmins = async (event: string, data: any, options: NotifyOptions = {}) => {
    try {
        const exclude = new Set((options.excludeUserIds ?? []).filter(Boolean).map((id) => String(id)));

        const managers = await User.find({
            role: { $in: [...ROLE_GROUPS.MANAGEMENT] },
            isDeleted: { $ne: true },
            isActive: true,
        }).select('_id');

        let sent = 0;
        for (const manager of managers) {
            const managerId = String(manager._id);
            if (exclude.has(managerId)) continue;

            let notificationPayload = data;
            if (event === 'notify:new') {
                const doc = await Notification.create({
                    userId: manager._id,
                    title: data.title,
                    message: data.message,
                    type: data.type || 'info',
                    actionType: data.actionType || 'system',
                    actionId: data.actionId,
                    isRead: false,
                });
                notificationPayload = doc.toObject();
            }

            emitToUser(managerId, event, notificationPayload);
            if (event === 'notify:new') {
                void sendWebPushToUser(managerId, notificationPayload);
                void sendTelegramToUser(managerId, notificationPayload);
            }
            sent += 1;
        }

        return sent;
    } catch (error) {
        console.error('[Notification] Error notifying managers:', error);
        return 0;
    }
};

/**
 * Send notification to a specific user
 */
export const notifyUser = async (userId: string, event: string, data: any) => {
    try {
        let notificationPayload = data;

        if (event === 'notify:new') {
            const doc = await Notification.create({
                userId: userId,
                title: data.title,
                message: data.message,
                type: data.type || 'info',
                actionType: data.actionType || 'system',
                actionId: data.actionId,
                isRead: false,
            });
            notificationPayload = doc.toObject();
        }

        emitToUser(userId, event, notificationPayload);
        if (event === 'notify:new') {
            void sendWebPushToUser(userId, notificationPayload);
            void sendTelegramToUser(userId, notificationPayload);
        }
    } catch (error) {
        console.error('[Notification] Error notifying user:', error);
    }
};

/**
 * Bản đồng bộ dành cho các tác vụ cần lưu biên nhận phân phối. Các luồng thông
 * báo hiện tại vẫn dùng notifyUser để không phải chờ các kênh ngoài ứng dụng.
 */
export const notifyUserTracked = async (
    userId: string,
    event: string,
    data: any
): Promise<NotificationDeliverySummary> => {
    const summary: NotificationDeliverySummary = {
        inAppCreated: 0,
        webPushSent: 0,
        telegramSent: 0,
        failedChannels: 0,
    };

    try {
        let notificationPayload = data;
        if (event === 'notify:new') {
            const doc = await Notification.create({
                userId,
                title: data.title,
                message: data.message,
                type: data.type || 'info',
                actionType: data.actionType || 'system',
                actionId: data.actionId,
                isRead: false,
            });
            notificationPayload = doc.toObject();
            summary.inAppCreated = 1;
        }

        emitToUser(userId, event, notificationPayload);
        if (event !== 'notify:new') return summary;

        const [webPush, telegram] = await Promise.all([
            sendWebPushToUser(userId, notificationPayload),
            sendTelegramToUser(userId, notificationPayload),
        ]);
        summary.webPushSent = webPush.sent;
        summary.telegramSent = telegram.sent;
        summary.failedChannels = webPush.failed + telegram.failed;
    } catch (error) {
        console.error('[Notification] Error notifying tracked user:', error);
        summary.failedChannels += 1;
    }

    return summary;
};

/**
 * Thông báo lặp theo một luồng nghiệp vụ: cập nhật cùng document thay vì
 * tăng badge và tạo hàng loạt bản ghi mới sau mỗi chu kỳ.
 */
export const notifyUserUpserted = async (
    userId: string,
    data: any,
    options: UpsertedNotifyOptions
): Promise<NotificationDeliverySummary> => {
    const summary: NotificationDeliverySummary = {
        inAppCreated: 0,
        webPushSent: 0,
        telegramSent: 0,
        failedChannels: 0,
    };

    try {
        const existing = await Notification.findOne({ userId, dedupeKey: options.dedupeKey }).select('_id').lean();
        const notification = await Notification.findOneAndUpdate(
            { userId, dedupeKey: options.dedupeKey },
            {
                $set: {
                    title: data.title,
                    message: data.message,
                    type: data.type || 'info',
                    actionType: data.actionType || 'system',
                    actionId: data.actionId,
                    actionData: data.actionData,
                    deliveryTag: options.deliveryTag,
                    isRead: false,
                    readAt: null,
                    // Đưa nhắc việc đang còn hiệu lực trở lại đầu danh sách và
                    // gia hạn TTL, nhưng vẫn chỉ giữ một document cho cả ngày.
                    createdAt: new Date(),
                },
                $setOnInsert: { userId, dedupeKey: options.dedupeKey },
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
        summary.inAppCreated = existing ? 0 : 1;
        const payload = notification.toObject();
        emitToUser(userId, 'notify:new', payload);

        const webPush = await sendWebPushToUser(userId, payload, {
            ...options.webPush,
            tag: options.webPush?.tag || options.deliveryTag,
        });
        summary.webPushSent = webPush.sent;
        summary.failedChannels += webPush.failed;

        const shouldSendTelegram =
            options.telegramMode === 'always' || (options.telegramMode === 'fallback' && webPush.sent === 0);
        if (shouldSendTelegram) {
            const telegram = await sendTelegramToUser(userId, payload);
            summary.telegramSent = telegram.sent;
            summary.failedChannels += telegram.failed;
        }
    } catch (error) {
        console.error('[Notification] Error upserting notification:', error);
        summary.failedChannels += 1;
    }

    return summary;
};

/**
 * Check and send notifications for overdue maintenance
 * Should be called periodically (e.g., via cron job or after maintenance status check)
 */
export const checkAndNotifyOverdueMaintenance = async () => {
    let checked = 0;
    let notified = 0;
    try {
        const now = new Date();

        // Find maintenance items that are overdue
        const overdueMaintenances = await Maintenance.find({
            isDeleted: { $ne: true },
            status: 'in_progress',
            endDate: { $lt: now },
        }).populate('assetId');

        checked = overdueMaintenances.length;
        for (const maintenance of overdueMaintenances) {
            const assetName = (maintenance.assetId as any)?.name || 'Thiết bị';

            await notifyAdmins('notify:new', {
                type: 'error',
                actionType: 'maintenance',
                actionId: String(maintenance._id),
                title: 'Bảo trì quá hạn',
                message: `${assetName} có phiếu bảo trì đã quá hạn`,
            });

            // Update status to overdue
            await Maintenance.findByIdAndUpdate(maintenance._id, { status: 'overdue' });
            notified += 1;
        }
    } catch (error) {
        console.error('[Notification] Error checking overdue maintenance:', error);
    }

    return { checked, notified };
};
