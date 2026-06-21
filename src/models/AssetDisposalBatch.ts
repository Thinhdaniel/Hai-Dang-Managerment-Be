import mongoose from 'mongoose';
import { ASSET_DISPOSAL_BATCH_STATUS } from '@/constant/assetDisposal';

const AssetDisposalBatchSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        area: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: Object.values(ASSET_DISPOSAL_BATCH_STATUS),
            default: ASSET_DISPOSAL_BATCH_STATUS.SCANNING,
            required: true,
        },
        reason: {
            type: String,
            required: true,
            trim: true,
        },
        note: {
            type: String,
            trim: true,
        },
        submittedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        submittedAt: {
            type: Date,
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        approvedAt: {
            type: Date,
        },
        approvalNote: {
            type: String,
            trim: true,
        },
        completedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        completedAt: {
            type: Date,
        },
        cancelledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        cancelledAt: {
            type: Date,
        },
        cancelReason: {
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

AssetDisposalBatchSchema.index({ plantId: 1 });
AssetDisposalBatchSchema.index({ status: 1 });
AssetDisposalBatchSchema.index({ createdAt: -1 });

const AssetDisposalBatch = mongoose.model('AssetDisposalBatch', AssetDisposalBatchSchema);

export default AssetDisposalBatch;
