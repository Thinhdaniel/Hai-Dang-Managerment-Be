import mongoose from 'mongoose';

export interface ITelegramLinkToken {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    tokenHash: string;
    expiresAt: Date;
    usedAt?: Date | null;
    chatId?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const TelegramLinkTokenSchema = new mongoose.Schema<ITelegramLinkToken>(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        tokenHash: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: true,
        },
        usedAt: {
            type: Date,
            default: null,
        },
        chatId: {
            type: String,
            trim: true,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

TelegramLinkTokenSchema.index({ userId: 1, usedAt: 1, expiresAt: -1 });

const TelegramLinkToken = mongoose.model<ITelegramLinkToken>('TelegramLinkToken', TelegramLinkTokenSchema);

export default TelegramLinkToken;
