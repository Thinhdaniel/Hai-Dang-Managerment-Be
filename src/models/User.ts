import { USER_ROLE } from '@/constant/allowedRoles';
import { IUserSchema } from '@/types/user';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema(
    {
        fullname: {
            type: String,
            required: true,
            trim: true,
        },
        username: {
            type: String,
            unique: true,
            trim: true,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        password: {
            type: String,
            required: true,
            minlength: 6,
        },
        passwordResetToken: {
            type: String,
            select: false,
        },
        passwordResetExpiresAt: {
            type: Date,
            select: false,
        },
        passwordChangedAt: {
            type: Date,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        status: {
            type: Boolean,
            default: true,
        },
        avatarUrl: {
            type: String,
            default: null,
        },
        avatarUrlRef: {
            type: String,
            default: null,
        },
        phone: {
            type: String,
            trim: true,
        },
        role: {
            type: String,
            enum: Object.values(USER_ROLE),
            default: USER_ROLE.STAFF,
        },
        permission: {
            type: [String],
            default: [],
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        lastLoginAt: {
            type: Date,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
        deletedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

UserSchema.index({ plantId: 1 });

UserSchema.pre('save', async function () {
    if (this.isModified('password')) {
        const saltRounds = 10;
        this.password = await bcrypt.hash(this.password, saltRounds);
        this.passwordChangedAt = new Date();
    }
});

UserSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.password;
    delete obj.passwordResetToken;
    delete obj.passwordResetExpiresAt;
    return obj;
};

const User = mongoose.model<IUserSchema>('User', UserSchema);

export default User;
