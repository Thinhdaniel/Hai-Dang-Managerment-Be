import mongoose from 'mongoose';

const BorrowingSchema = new mongoose.Schema(
    {
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        type: {
            type: String,
            enum: ['internal', 'external', 'rental'],
            required: true,
        },
        status: {
            type: String,
            enum: ['active', 'returned'],
            default: 'active',
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
        assetStatusBefore: {
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
BorrowingSchema.index({ type: 1, status: 1 });
BorrowingSchema.index({ borrowerId: 1 });
BorrowingSchema.index({ borrowerName: 1 });
BorrowingSchema.index({ borrowTime: -1 });

const Borrowing = mongoose.model('Borrowing', BorrowingSchema);

export default Borrowing;
