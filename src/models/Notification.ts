import mongoose from 'mongoose';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';
export type NotificationActionType =
    | 'user'
    | 'asset'
    | 'transfer'
    | 'maintenance'
    | 'borrowing'
    | 'purchase_request'
    | 'supply_request'
    | 'technical_purchase'
    | 'purchase_order'
    | 'distribution'
    | 'chat'
    | 'system';

export interface INotification {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId | null; // null = broadcast to all
    title: string;
    message: string;
    type: NotificationType;
    actionType: NotificationActionType;
    actionId?: string;
    isRead: boolean;
    readAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const NotificationSchema = new mongoose.Schema<INotification>(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        title: { type: String, required: true, trim: true },
        message: { type: String, required: true, trim: true },
        type: {
            type: String,
            enum: ['info', 'success', 'warning', 'error'],
            default: 'info',
        },
        actionType: {
            type: String,
            enum: [
                'user',
                'asset',
                'transfer',
                'maintenance',
                'borrowing',
                'purchase_request',
                'supply_request',
                'technical_purchase',
                'purchase_order',
                'distribution',
                'chat',
                'system',
            ],
            default: 'system',
        },
        actionId: { type: String },
        isRead: { type: Boolean, default: false },
        readAt: { type: Date },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ isRead: 1 });
// TTL: Mongo tự xoá thông báo sau 90 ngày để collection không phình vô hạn
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

export default Notification;
