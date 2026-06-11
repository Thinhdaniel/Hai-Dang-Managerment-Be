import mongoose from 'mongoose';

const BorrowingBatchSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
        },
        type: {
            type: String,
            enum: ['external', 'rental'],
            required: true,
        },
        status: {
            type: String,
            enum: ['draft', 'receiving', 'active', 'partially_returned', 'returned', 'cancelled'],
            default: 'draft',
        },
        partnerName: {
            type: String,
            required: true,
            trim: true,
        },
        contractNo: {
            type: String,
            trim: true,
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
        borrowTime: {
            type: Date,
            required: true,
        },
        expectedReturnTime: {
            type: Date,
        },
        plannedQuantity: {
            type: Number,
            required: true,
            min: 1,
        },
        qrBatchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QrLabelBatch',
        },
        labelPolicy: {
            type: String,
            enum: ['temporary'],
            default: 'temporary',
        },
        removeQrOnReturn: {
            type: Boolean,
            default: true,
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
        closedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        closedAt: {
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

BorrowingBatchSchema.index({ status: 1, borrowTime: -1 });
BorrowingBatchSchema.index({ type: 1, status: 1 });
BorrowingBatchSchema.index({ partnerName: 1 });
BorrowingBatchSchema.index({ plantId: 1 });
BorrowingBatchSchema.index({ qrBatchId: 1 }, { sparse: true });

const BorrowingBatch = mongoose.model('BorrowingBatch', BorrowingBatchSchema);

export default BorrowingBatch;
