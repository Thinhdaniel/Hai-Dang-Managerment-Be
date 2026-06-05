import mongoose from 'mongoose';

export interface IPushSubscription {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    endpoint: string;
    expirationTime?: number | null;
    keys: {
        p256dh: string;
        auth: string;
    };
    deviceName?: string;
    userAgent?: string;
    platform?: string;
    isActive: boolean;
    lastSeenAt?: Date;
    failureCount: number;
    revokedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const PushSubscriptionSchema = new mongoose.Schema<IPushSubscription>(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        endpoint: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        expirationTime: { type: Number, default: null },
        keys: {
            p256dh: { type: String, required: true },
            auth: { type: String, required: true },
        },
        deviceName: { type: String, trim: true },
        userAgent: { type: String, trim: true },
        platform: { type: String, trim: true },
        isActive: { type: Boolean, default: true, index: true },
        lastSeenAt: { type: Date, default: Date.now },
        failureCount: { type: Number, default: 0 },
        revokedAt: { type: Date, default: null },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

PushSubscriptionSchema.index({ userId: 1, isActive: 1, updatedAt: -1 });

const PushSubscription = mongoose.model<IPushSubscription>('PushSubscription', PushSubscriptionSchema);

export default PushSubscription;
