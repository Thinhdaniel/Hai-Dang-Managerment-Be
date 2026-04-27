import mongoose from 'mongoose';
import { IMaintenanceHistory } from '@/types/history';

const MaintenanceHistorySchema = new mongoose.Schema(
    {
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        note: {
            type: String,
            trim: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
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

MaintenanceHistorySchema.index({ assetId: 1 });

const MaintenanceHistory = mongoose.model<IMaintenanceHistory>('MaintenanceHistory', MaintenanceHistorySchema);

export default MaintenanceHistory;
