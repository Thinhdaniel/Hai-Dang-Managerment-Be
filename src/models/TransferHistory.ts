import mongoose from 'mongoose';
import { ITransferHistory } from '@/types/history';

const TransferHistorySchema = new mongoose.Schema(
    {
        machineId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        fromPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        fromPlant: {
            type: String,
        },
        toPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        toPlant: {
            type: String,
        },
        note: {
            type: String,
            trim: true,
        },
        createdBy: {
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
        timestamps: { createdAt: true, updatedAt: false },
        versionKey: false,
    }
);

TransferHistorySchema.index({ machineId: 1 });
TransferHistorySchema.index({ fromPlantId: 1 });
TransferHistorySchema.index({ toPlantId: 1 });

const TransferHistory = mongoose.model<ITransferHistory>('TransferHistory', TransferHistorySchema);

export default TransferHistory;
