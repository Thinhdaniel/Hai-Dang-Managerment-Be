import { Document, Types } from 'mongoose';

export interface IUserSession extends Document {
    userId: Types.ObjectId;
    refreshToken: string;
    expireAt: Date;
    revoked: boolean;
    revokedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
