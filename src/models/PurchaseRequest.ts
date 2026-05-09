import mongoose from 'mongoose';

const PurchaseRequestItemSchema = new mongoose.Schema(
    {
        materialId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Material',
        },
        materialName: { type: String, trim: true },
        unit: { type: String, trim: true },
        // ── Spec mới ──────────────────────────────────────────────
        proposedBy: { type: String, trim: true },
        purpose: { type: String, trim: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        plantName: { type: String, trim: true },
        quantityRequested: { type: Number, required: true, min: 0 },
        quantityApproved: { type: Number, min: 0 },
        quantityOrdered: { type: Number, min: 0 },
        unitPrice: { type: Number, min: 0 },
        totalPrice: { type: Number, min: 0 },
        vatRate: { type: Number, default: 0.08, min: 0 },
        vatAmount: { type: Number, min: 0 },
        totalWithVat: { type: Number, min: 0 },
        orderDate: { type: Date },
        receivedDate: { type: Date },
        supplierName: { type: String, trim: true },
        supplierNote: { type: String, trim: true },
        // ── Legacy ────────────────────────────────────────────────
        estimatedPrice: { type: Number, min: 0 },
        estimatedTotal: { type: Number, min: 0 },
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        note: { type: String, trim: true },
    },
    { _id: false }
);

const PurchaseRequestSchema = new mongoose.Schema(
    {
        requestCode: { type: String, trim: true },
        requestType: {
            type: String,
            enum: ['purchase', 'supply_request'],
            default: 'purchase',
        },
        fromPlantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        toPlantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        status: {
            type: String,
            enum: ['draft', 'pending', 'approved', 'rejected', 'ordered', 'received', 'in_progress', 'distributed'],
            default: 'pending',
        },
        items: { type: [PurchaseRequestItemSchema], default: [] },
        totalEstimated: { type: Number, default: 0, min: 0 },
        totalActual: { type: Number, default: 0, min: 0 },
        totalWithVat: { type: Number, default: 0, min: 0 },
        requestMonth: { type: Number, min: 1, max: 12 },
        requestYear: { type: Number },
        requestDate: { type: Date },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        approvedAt: { type: Date },
        rejectedReason: { type: String, trim: true },
        note: { type: String, trim: true },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

PurchaseRequestSchema.index(
    { requestCode: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false, requestCode: { $exists: true, $type: 'string' } } }
);
PurchaseRequestSchema.index({ plantId: 1, status: 1 });
PurchaseRequestSchema.index({ requestedBy: 1, status: 1 });
PurchaseRequestSchema.index({ approvedBy: 1 });
PurchaseRequestSchema.index({ createdAt: -1 });
PurchaseRequestSchema.index({ requestType: 1, status: 1 });
PurchaseRequestSchema.index({ fromPlantId: 1, status: 1 });
PurchaseRequestSchema.index({ toPlantId: 1, status: 1 });
PurchaseRequestSchema.index({ requestYear: 1, requestMonth: 1 });

const PurchaseRequest = mongoose.model('PurchaseRequest', PurchaseRequestSchema);

export default PurchaseRequest;
