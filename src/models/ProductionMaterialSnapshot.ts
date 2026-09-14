import mongoose from 'mongoose';

const SnapshotInboundSchema = new mongoose.Schema(
    {
        purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
        purchaseOrderCode: { type: String, trim: true, maxlength: 80 },
        quantity: { type: Number, min: 0, default: 0 },
        expectedDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    },
    { _id: false }
);

const SnapshotLineSchema = new mongoose.Schema(
    {
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        materialCode: { type: String, trim: true, maxlength: 80 },
        materialName: { type: String, required: true, trim: true, maxlength: 240 },
        unit: { type: String, required: true, trim: true, maxlength: 40 },
        isRequired: { type: Boolean, default: true },
        requiredQuantity: { type: Number, min: 0, default: 0 },
        onHandQuantity: { type: Number, default: 0 },
        reservedForOrderQuantity: { type: Number, min: 0, default: 0 },
        reservedForOtherOrdersQuantity: { type: Number, min: 0, default: 0 },
        freeQuantity: { type: Number, min: 0, default: 0 },
        availableForOrderQuantity: { type: Number, min: 0, default: 0 },
        inboundQuantity: { type: Number, min: 0, default: 0 },
        confirmedInboundQuantity: { type: Number, min: 0, default: 0 },
        shortageQuantity: { type: Number, min: 0, default: 0 },
        status: { type: String, enum: ['ready', 'partial', 'shortage'], required: true },
        readyDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        inboundSources: { type: [SnapshotInboundSchema], default: [] },
    },
    { _id: false }
);

const ProductionMaterialSnapshotSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        productionOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionOrder', required: true },
        productionOrderCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
        bomId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBom' },
        bomVersion: { type: Number, min: 1 },
        asOf: { type: Date, default: Date.now, required: true },
        status: { type: String, enum: ['ready', 'partial', 'shortage', 'unknown'], required: true },
        materialReadyDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        lines: { type: [SnapshotLineSchema], default: [] },
        summary: {
            requiredLineCount: { type: Number, min: 0, default: 0 },
            readyLineCount: { type: Number, min: 0, default: 0 },
            shortageLineCount: { type: Number, min: 0, default: 0 },
            unknownInboundLineCount: { type: Number, min: 0, default: 0 },
        },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

ProductionMaterialSnapshotSchema.index({ productionOrderId: 1, asOf: -1 });
ProductionMaterialSnapshotSchema.index({ plantId: 1, status: 1, asOf: -1 });

export default mongoose.model('ProductionMaterialSnapshot', ProductionMaterialSnapshotSchema);
