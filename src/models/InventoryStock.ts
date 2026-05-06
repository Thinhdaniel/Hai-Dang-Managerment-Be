import mongoose from 'mongoose';

const InventoryStockSchema = new mongoose.Schema(
    {
        materialId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Material',
            required: true,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        currentStock: {
            type: Number,
            default: 0,
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
            createdAt: false,
            updatedAt: 'lastUpdated',
        },
        versionKey: false,
    }
);

InventoryStockSchema.index(
    { materialId: 1, plantId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
        },
    }
);
InventoryStockSchema.index({ plantId: 1 });
InventoryStockSchema.index({ currentStock: 1 });

const InventoryStock = mongoose.model('InventoryStock', InventoryStockSchema);

export default InventoryStock;
