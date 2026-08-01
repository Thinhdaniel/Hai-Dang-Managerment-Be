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
    | 'digest'
    | 'briefing'
    | 'floor_map'
    | 'production'
    | 'system';

export interface INotification {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId | null; // null = broadcast to all
    title: string;
    message: string;
    type: NotificationType;
    actionType: NotificationActionType;
    actionId?: string;
    actionData?: Record<string, unknown>;
    dedupeKey?: string;
    deliveryTag?: string;
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
                'digest',
                'briefing',
                'floor_map',
                'production',
                'system',
            ],
            default: 'system',
        },
        actionId: { type: String },
        actionData: { type: mongoose.Schema.Types.Mixed },
        dedupeKey: { type: String, trim: true, maxlength: 220 },
        deliveryTag: { type: String, trim: true, maxlength: 220 },
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
NotificationSchema.index(
    { userId: 1, dedupeKey: 1 },
    {
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: 'string' } },
        name: 'notification_user_dedupe_key',
    }
);
// TTL: Mongo tự xoá thông báo sau 90 ngày để collection không phình vô hạn
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

export default Notification;
