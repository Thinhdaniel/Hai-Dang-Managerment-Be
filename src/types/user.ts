import { USER_ROLE } from '@/constant/allowedRoles';
import { Document, Types } from 'mongoose';

export interface IUserSchema extends Document {
    fullname: string;
    username: string;
    email: string;
    password: string;
    passwordResetToken?: string;
    passwordResetExpiresAt?: Date;
    passwordChangedAt?: Date;
    role: USER_ROLE;
    permission: string[];
    phone?: string;
    avatarUrl?: string;
    avatarUrlRef?: string;
    isActive: boolean;
    status: boolean;
    plantId?: Types.ObjectId;
    lastLoginAt?: Date;
    telegramChatId?: string | null;
    telegramUsername?: string | null;
    telegramFirstName?: string | null;
    telegramLinkedAt?: Date | null;
    telegramDisabledAt?: Date | null;
    telegramLastError?: string | null;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
