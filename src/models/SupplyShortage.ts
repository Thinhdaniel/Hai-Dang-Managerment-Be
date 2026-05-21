import mongoose from 'mongoose';

const SupplyShortageResolutionSchema = new mongoose.Schema(
    {
        distributionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DistributionRecord' },
        distributionCode: { type: String, trim: true },
        quantity: { type: Number, required: true, min: 0 },
        resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        resolvedAt: { type: Date, default: Date.now },
        note: { type: String, trim: true },
    },
    { _id: false }
);

const SupplyShortageSchema = new mongoose.Schema(
    {
        originalSupplyRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequest', required: true },
        originalSupplyRequestCode: { type: String, trim: true },
        originalDistributionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DistributionRecord', required: true },
        originalDistributionCode: { type: String, trim: true },
        originalItemIndex: { type: Number, required: true, min: 0 },
        toPlantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        materialName: { type: String, trim: true, required: true },
        unit: { type: String, trim: true },
        quantityRequested: { type: Number, required: true, min: 0 },
        quantityDistributed: { type: Number, required: true, min: 0 },
        quantityShortage: { type: Number, required: true, min: 0 },
        quantityResolved: { type: Number, default: 0, min: 0 },
        status: {
            type: String,
            enum: ['outstanding', 'partially_settled', 'settled', 'cancelled'],
            default: 'outstanding',
        },
        reason: { type: String, trim: true },
        resolutions: { type: [SupplyShortageResolutionSchema], default: [] },
        note: { type: String, trim: true },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

SupplyShortageSchema.index(
    { originalSupplyRequestId: 1, originalItemIndex: 1, originalDistributionId: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false } }
);
SupplyShortageSchema.index({ originalSupplyRequestId: 1, status: 1 });
SupplyShortageSchema.index({ originalDistributionId: 1 });
SupplyShortageSchema.index({ materialId: 1, status: 1 });
SupplyShortageSchema.index({ toPlantId: 1, status: 1 });
SupplyShortageSchema.index({ createdAt: -1 });

const SupplyShortage = mongoose.model('SupplyShortage', SupplyShortageSchema);

export default SupplyShortage;
