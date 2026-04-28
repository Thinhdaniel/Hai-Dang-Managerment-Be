import { emitToUser } from '@/lib/socket';
import User from '@/models/User';
import Maintenance from '@/models/Maintenance';

/**
 * Send notification to all admins/managers
 */
export const notifyAdmins = async (event: string, data: unknown) => {
    try {
        // Get all admin and manager users
        const admins = await User.find({
            role: { $in: ['admin', 'manager'] },
            isDeleted: { $ne: true },
            isActive: true,
        });

        // Emit to each admin
        for (const admin of admins) {
            emitToUser(String(admin._id), event, data);
        }

        console.log(`[Notification] Sent to ${admins.length} admins`);
    } catch (error) {
        console.error('[Notification] Error notifying admins:', error);
    }
};

/**
 * Send notification to a specific user
 */
export const notifyUser = (userId: string, event: string, data: unknown) => {
    try {
        emitToUser(userId, event, data);
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
                _id: `maintenance-overdue-${maintenance._id}`,
                userId: '',
                type: 'error',
                actionType: 'maintenance',
                actionId: String(maintenance._id),
                title: 'Bảo trì quá hạn',
                message: `${assetName} có phiếu bảo trì đã quá hạn`,
                isRead: false,
                createdAt: new Date().toISOString(),
            });

            // Update status to overdue
            await Maintenance.findByIdAndUpdate(maintenance._id, { status: 'overdue' });
        }

        console.log(`[Notification] Checked overdue maintenance: ${overdueMaintenances.length} found`);
    } catch (error) {
        console.error('[Notification] Error checking overdue maintenance:', error);
    }
};