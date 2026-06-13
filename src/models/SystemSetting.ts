import mongoose, { Schema, type Document } from 'mongoose';

// Cấu hình hệ thống dạng key-value (vd: chuông thông báo dùng chung) — chỉ admin được ghi
export interface ISystemSetting extends Document {
    key: string;
    value: Record<string, any>;
    updatedBy?: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const SystemSettingSchema = new Schema<ISystemSetting>(
    {
        key: { type: String, required: true, unique: true, trim: true },
        value: { type: Schema.Types.Mixed, default: {} },
        updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

const SystemSetting = mongoose.model<ISystemSetting>('SystemSetting', SystemSettingSchema);

export default SystemSetting;
