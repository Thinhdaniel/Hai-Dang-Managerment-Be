import mongoose from 'mongoose';

const ShortageResolutionSchema = new mongoose.Schema(
    {
        purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
        purchaseOrderCode: { type: String, trim: true },
        quantity: { type: Number, required: true, min: 0 },
        resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        resolvedAt: { type: Date, default: Date.now },
        note: { type: String, trim: true },
    },
    { _id: false }
);

const PurchaseShortageSchema = new mongoose.Schema(
    {
        originalPurchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
        originalPurchaseOrderCode: { type: String, trim: true },
        originalItemIndex: { type: Number, required: true, min: 0 },
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        supplierName: { type: String, trim: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        materialName: { type: String, trim: true, required: true },
        unit: { type: String, trim: true },
        quantityMissing: { type: Number, required: true, min: 0 },
        quantityResolved: { type: Number, default: 0, min: 0 },
        status: {
            type: String,
            enum: ['outstanding', 'partially_settled', 'settled', 'cancelled'],
            default: 'outstanding',
        },
        resolutions: { type: [ShortageResolutionSchema], default: [] },
        note: { type: String, trim: true },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

PurchaseShortageSchema.index(
    { originalPurchaseOrderId: 1, originalItemIndex: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false } }
);
PurchaseShortageSchema.index({ supplierId: 1, status: 1 });
PurchaseShortageSchema.index({ materialId: 1, status: 1 });
PurchaseShortageSchema.index({ createdAt: -1 });

const PurchaseShortage = mongoose.model('PurchaseShortage', PurchaseShortageSchema);
export default PurchaseShortage;
