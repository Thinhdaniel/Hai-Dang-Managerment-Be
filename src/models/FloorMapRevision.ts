import mongoose from 'mongoose';

const FloorPositionSchema = new mongoose.Schema(
    {
        x: { type: Number, required: true, min: 0, max: 100 },
        y: { type: Number, required: true, min: 0, max: 100 },
    },
    { _id: false }
);

const FloorMapRevisionChangeSchema = new mongoose.Schema(
    {
        assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true },
        machineCode: { type: String, trim: true },
        name: { type: String, trim: true },
        before: { type: FloorPositionSchema, default: null },
        after: { type: FloorPositionSchema, default: null },
    },
    { _id: false }
);

const FloorMapRevisionSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true, index: true },
        source: { type: String, enum: ['manual', 'stocktake'], required: true },
        stocktakeSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'StocktakeSession' },
        changes: { type: [FloorMapRevisionChangeSchema], required: true, default: [] },
        status: { type: String, enum: ['applied', 'reverted', 'partial'], default: 'applied' },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        revertedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        revertedAt: { type: Date },
        conflictAssetIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    },
    { timestamps: true, versionKey: false }
);

FloorMapRevisionSchema.index({ plantId: 1, createdAt: -1 });
FloorMapRevisionSchema.index({ stocktakeSessionId: 1, createdAt: -1 });

export default mongoose.model('FloorMapRevision', FloorMapRevisionSchema);
