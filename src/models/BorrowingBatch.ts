import mongoose from 'mongoose';
import { BORROWING_BATCH_STATUS, BORROWING_DIRECTION } from '@/constant/borrowing';

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
        direction: {
            type: String,
            enum: [BORROWING_DIRECTION.INBOUND, BORROWING_DIRECTION.OUTBOUND],
            default: BORROWING_DIRECTION.INBOUND,
        },
        status: {
            type: String,
            enum: Object.values(BORROWING_BATCH_STATUS),
            default: BORROWING_BATCH_STATUS.DRAFT,
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
        contactName: {
            type: String,
            trim: true,
        },
        contactPhone: {
            type: String,
            trim: true,
        },
        partnerAddress: {
            type: String,
            trim: true,
        },
        purpose: {
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
            enum: ['temporary', 'permanent'],
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
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        rejectedAt: {
            type: Date,
        },
        rejectReason: {
            type: String,
            trim: true,
        },
        handedOverBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        handedOverAt: {
            type: Date,
        },
        handoverImages: {
            type: [String],
            default: [],
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
BorrowingBatchSchema.index({ direction: 1, status: 1, borrowTime: -1 });
BorrowingBatchSchema.index({ partnerName: 1 });
BorrowingBatchSchema.index({ plantId: 1 });
BorrowingBatchSchema.index({ qrBatchId: 1 }, { sparse: true });

const BorrowingBatch = mongoose.model('BorrowingBatch', BorrowingBatchSchema);

export default BorrowingBatch;
