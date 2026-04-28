import { emitToUser } from '@/lib/socket';
import User from '@/models/User';
import Maintenance from '@/models/Maintenance';
import Notification from '@/models/Notification';

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

/**
 * Send notification to all admins/managers
 */
export const notifyAdmins = async (event: string, data: any) => {
    try {
        // Get all admin and manager users
        const admins = await User.find({
            role: { $in: ['admin', 'manager'] },
            isDeleted: { $ne: true },
            isActive: true,
        });

        // Emit to each admin
        for (const admin of admins) {
            let notificationPayload = data;

            if (event === 'notify:new') {
                const doc = await Notification.create({
                    userId: admin._id,
                    title: data.title,
                    message: data.message,
                    type: data.type || 'info',
                    actionType: data.actionType || 'system',
                    actionId: data.actionId,
                    isRead: false,
                });
                notificationPayload = doc.toObject();
            }

            emitToUser(String(admin._id), event, notificationPayload);
        }

        console.log(`[Notification] Sent to ${admins.length} admins`);
    } catch (error) {
        console.error('[Notification] Error notifying admins:', error);
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
    } catch (error) {
        console.error('[Notification] Error notifying user:', error);
    }
};

/**
 * Check and send notifications for overdue maintenance
 * Should be called periodically (e.g., via cron job or after maintenance status check)
 */
export const checkAndNotifyOverdueMaintenance = async () => {
    try {
        const now = new Date();
        
        // Find maintenance items that are overdue
        const overdueMaintenances = await Maintenance.find({
            isDeleted: { $ne: true },
            status: 'in_progress',
            endDate: { $lt: now },
        }).populate('assetId');

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
        }

        console.log(`[Notification] Checked overdue maintenance: ${overdueMaintenances.length} found`);
    } catch (error) {
        console.error('[Notification] Error checking overdue maintenance:', error);
    }
};