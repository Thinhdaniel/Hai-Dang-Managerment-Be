import mongoose from 'mongoose';

export type PushDeliveryStatus = 'sent' | 'failed';

export interface IPushDeliveryLog {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    notificationId?: mongoose.Types.ObjectId | null;
    pushSubscriptionId?: mongoose.Types.ObjectId | null;
    endpointTail?: string;
    deviceName?: string;
    platform?: string;
    status: PushDeliveryStatus;
    detailed: boolean;
    statusCode?: number;
    errorMessage?: string;
    attemptedAt: Date;
    completedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const PushDeliveryLogSchema = new mongoose.Schema<IPushDeliveryLog>(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        notificationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Notification',
            default: null,
            index: true,
        },
        pushSubscriptionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PushSubscription',
            default: null,
            index: true,
        },
        endpointTail: { type: String, trim: true },
        deviceName: { type: String, trim: true },
        platform: { type: String, trim: true },
        status: {
            type: String,
            enum: ['sent', 'failed'],
            required: true,
            index: true,
        },
        detailed: { type: Boolean, default: false },
        statusCode: { type: Number },
        errorMessage: { type: String, trim: true },
        attemptedAt: { type: Date, required: true, default: Date.now },
        completedAt: { type: Date },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

PushDeliveryLogSchema.index({ userId: 1, createdAt: -1 });
PushDeliveryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const PushDeliveryLog = mongoose.model<IPushDeliveryLog>('PushDeliveryLog', PushDeliveryLogSchema);

export default PushDeliveryLog;
