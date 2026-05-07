import mongoose from 'mongoose';

const TransferSchema = new mongoose.Schema(
    {
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        fromPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        fromArea: {
            type: String,
            trim: true,
        },
        toPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        toArea: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'completed', 'rejected', 'cancelled'],
            default: 'pending',
        },
        reason: {
            type: String,
            required: true,
            trim: true,
        },
        transferDate: {
            type: Date,
            required: true,
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        approvedAt: {
            type: Date,
        },
        completedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        completedAt: {
            type: Date,
        },
        receivedBy: {
            type: String,
            trim: true,
        },
        handoverImages: {
            type: [String],
            default: [],
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
        note: {
            type: String,
            trim: true,
        },
        rejectReason: {
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
        timestamps: true,
        versionKey: false,
    }
);

TransferSchema.index({ assetId: 1 });
TransferSchema.index({ fromPlantId: 1 });
TransferSchema.index({ toPlantId: 1 });
TransferSchema.index({ status: 1 });
TransferSchema.index({ assetId: 1, status: 1 });

const Transfer = mongoose.model('Transfer', TransferSchema);

export default Transfer;
