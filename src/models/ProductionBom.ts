import mongoose from 'mongoose';

const ProductionBomLineSchema = new mongoose.Schema(
    {
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        materialCode: { type: String, trim: true, maxlength: 80 },
        materialName: { type: String, required: true, trim: true, maxlength: 240 },
        unit: { type: String, required: true, trim: true, maxlength: 40 },
        quantityPerUnit: { type: Number, required: true, min: 0.000001, max: 1_000_000 },
        wastagePercent: { type: Number, default: 0, min: 0, max: 100 },
        isRequired: { type: Boolean, default: true },
        operationName: { type: String, trim: true, maxlength: 160 },
        note: { type: String, trim: true, maxlength: 300 },
    },
    { _id: true }
);

const ProductionBomHistorySchema = new mongoose.Schema(
    {
        type: { type: String, enum: ['created', 'updated', 'approved', 'archived'], required: true },
        note: { type: String, trim: true, maxlength: 500 },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, default: Date.now, required: true },
    },
    { _id: true }
);

const ProductionBomSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem', required: true },
        itemCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
        itemName: { type: String, trim: true, maxlength: 200 },
        version: { type: Number, required: true, min: 1 },
        status: { type: String, enum: ['draft', 'approved', 'archived'], default: 'draft' },
        effectiveFrom: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        note: { type: String, trim: true, maxlength: 500 },
        lines: { type: [ProductionBomLineSchema], default: [] },
        revision: { type: Number, min: 0, default: 0 },
        approvedAt: { type: Date },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        history: { type: [ProductionBomHistorySchema], default: [] },
    },
    { timestamps: true, optimisticConcurrency: true }
);

ProductionBomSchema.index({ plantId: 1, itemId: 1, version: 1 }, { unique: true });
ProductionBomSchema.index({ plantId: 1, itemId: 1, status: 1 });
ProductionBomSchema.index(
    { plantId: 1, itemId: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: 'approved' } }
);

export default mongoose.model('ProductionBom', ProductionBomSchema);
