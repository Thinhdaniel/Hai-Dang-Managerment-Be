import mongoose from 'mongoose';
import { IUserSession } from '@/types/user_session';

const UserSessionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        refreshToken: {
            type: String,
            required: true,
        },
        expireAt: {
            type: Date,
            required: true,
        },
        revoked: {
            type: Boolean,
            default: false,
        },
        revokedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

UserSessionSchema.index({ userId: 1 });
UserSessionSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // Automatic deletion if desired, or just for indexing

const UserSession = mongoose.model<IUserSession>('UserSession', UserSessionSchema);

export default UserSession;
