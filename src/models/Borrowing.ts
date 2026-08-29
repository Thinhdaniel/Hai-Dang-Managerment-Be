import mongoose from 'mongoose';
import { BORROWING_DIRECTION, BORROWING_ITEM_STATUS } from '@/constant/borrowing';

const BorrowingSchema = new mongoose.Schema(
    {
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        batchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'BorrowingBatch',
        },
        qrLabelId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QrLabel',
        },
        type: {
            type: String,
            enum: ['internal', 'external', 'rental'],
            required: true,
        },
        direction: {
            type: String,
            enum: Object.values(BORROWING_DIRECTION),
        },
        status: {
            type: String,
            enum: Object.values(BORROWING_ITEM_STATUS),
            default: BORROWING_ITEM_STATUS.ACTIVE,
        },
        borrowerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        borrowerName: {
            type: String,
            trim: true,
        },
        partnerName: {
            type: String,
            trim: true,
        },
        borrowTime: {
            type: Date,
            required: true,
        },
        returnTime: {
            type: Date,
        },
        expectedReturnTime: {
            type: Date,
        },
        partnerMachineCode: {
            type: String,
            trim: true,
        },
        purpose: {
            type: String,
            trim: true,
        },
        location: {
            type: String,
            trim: true,
        },
        cost: {
            type: Number,
            min: 0,
        },
        note: {
            type: String,
            trim: true,
        },
        returnNote: {
            type: String,
            trim: true,
        },
        receiveCondition: {
            type: String,
            trim: true,
        },
        receiveNote: {
            type: String,
            trim: true,
        },
        issueCondition: {
            type: String,
            trim: true,
        },
        issueNote: {
            type: String,
            trim: true,
        },
        accessories: {
            type: [String],
            default: [],
        },
        issueImages: {
            type: [String],
            default: [],
        },
        returnCondition: {
            type: String,
            trim: true,
        },
        returnImages: {
            type: [String],
            default: [],
        },
        qrReturnAction: {
            type: String,
            enum: ['removed', 'lost', 'damaged', 'left_on_partner'],
        },
        qrReturnNote: {
            type: String,
            trim: true,
        },
        qrRemovedAt: {
            type: Date,
        },
        qrRemovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        returnedInBatchAt: {
            type: Date,
        },
        assetStatusBefore: {
            type: String,
            trim: true,
        },
        assetOwnershipTypeBefore: {
            type: String,
            trim: true,
        },
        assetPlantIdBefore: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        assetAreaBefore: {
            type: String,
            trim: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        returnedBy: {
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
        collection: 'device_transactions',
    }
);

BorrowingSchema.index({ assetId: 1, status: 1 });
BorrowingSchema.index({ batchId: 1, status: 1 });
BorrowingSchema.index({ qrLabelId: 1 }, { sparse: true });
BorrowingSchema.index({ type: 1, status: 1 });
BorrowingSchema.index({ direction: 1, status: 1 });
BorrowingSchema.index({ borrowerId: 1 });
BorrowingSchema.index({ borrowerName: 1 });
BorrowingSchema.index({ borrowTime: -1 });

const Borrowing = mongoose.model('Borrowing', BorrowingSchema);

export default Borrowing;
