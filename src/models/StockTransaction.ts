import mongoose from 'mongoose';

const StockTransactionSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['import', 'export', 'adjust'],
            required: true,
        },
        materialId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Material',
            required: true,
        },
        materialName: {
            type: String,
            trim: true,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        quantity: {
            type: Number,
            required: true,
        },
        stockBefore: {
            type: Number,
        },
        stockAfter: {
            type: Number,
        },
        relatedId: {
            type: mongoose.Schema.Types.ObjectId,
        },
        relatedType: {
            type: String,
            enum: ['purchase_order', 'distribution', 'manual'],
            default: 'manual',
        },
        performedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        note: {
            type: String,
            trim: true,
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
        timestamps: {
            createdAt: true,
            updatedAt: false,
        },
        versionKey: false,
    }
);

StockTransactionSchema.index({ materialId: 1, createdAt: -1 });
StockTransactionSchema.index({ plantId: 1, createdAt: -1 });
StockTransactionSchema.index({ type: 1, createdAt: -1 });
StockTransactionSchema.index({ relatedType: 1, relatedId: 1 });

const StockTransaction = mongoose.model('StockTransaction', StockTransactionSchema);

export default StockTransaction;
