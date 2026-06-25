import mongoose from 'mongoose';

export type TelegramDeliveryStatus = 'sent' | 'failed';

export interface ITelegramDeliveryLog {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    notificationId?: mongoose.Types.ObjectId | null;
    chatIdTail?: string;
    status: TelegramDeliveryStatus;
    statusCode?: number;
    errorMessage?: string;
    attemptedAt: Date;
    completedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const TelegramDeliveryLogSchema = new mongoose.Schema<ITelegramDeliveryLog>(
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
        chatIdTail: { type: String, trim: true },
        status: {
            type: String,
            enum: ['sent', 'failed'],
            required: true,
            index: true,
        },
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

TelegramDeliveryLogSchema.index({ userId: 1, createdAt: -1 });
TelegramDeliveryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const TelegramDeliveryLog = mongoose.model<ITelegramDeliveryLog>('TelegramDeliveryLog', TelegramDeliveryLogSchema);

export default TelegramDeliveryLog;
