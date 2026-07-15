import mongoose from 'mongoose';

const POSourceLineSchema = new mongoose.Schema(
    {
        purchaseRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequest' },
        purchaseRequestCode: { type: String, trim: true },
        requestItemIndex: { type: Number, min: 0 },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        materialName: { type: String, trim: true },
        unit: { type: String, trim: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        plantName: { type: String, trim: true },
        proposedBy: { type: String, trim: true },
        purpose: { type: String, trim: true },
        quantityRequested: { type: Number, min: 0, default: 0 },
        quantityOrdered: { type: Number, min: 0, default: 0 },
    },
    { _id: false }
);

const POItemSchema = new mongoose.Schema(
    {
        purchaseRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequest' },
        purchaseRequestCode: { type: String, trim: true },
        sourceLines: { type: [POSourceLineSchema], default: [] },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        materialName: { type: String, trim: true },
        unit: { type: String, trim: true },
        quantityRequested: { type: Number, min: 0, default: 0 },
        quantityOrdered: { type: Number, min: 0, default: 0 },
        quantityReceived: { type: Number, min: 0, default: 0 },
        quantityMissing: { type: Number, min: 0, default: 0 },
        lineStatus: {
            type: String,
            enum: ['active', 'cancelled'],
            default: 'active',
        },
        cancelledQuantity: { type: Number, min: 0 },
        cancelledAt: { type: Date },
        cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        cancelledReason: { type: String, trim: true },
        receiveStatus: {
            type: String,
            enum: ['pending', 'partially_received', 'received', 'cancelled'],
            default: 'pending',
        },
        unitPrice: { type: Number, min: 0, default: 0 },
        totalPrice: { type: Number, min: 0, default: 0 },
        vatRate: { type: Number, min: 0, default: 0 },
        vatAmount: { type: Number, min: 0, default: 0 },
        totalWithVat: { type: Number, min: 0, default: 0 },
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        supplierName: { type: String, trim: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        plantName: { type: String, trim: true },
        proposedBy: { type: String, trim: true },
        purpose: { type: String, trim: true },
        catalogStatus: {
            type: String,
            enum: ['matched', 'unmatched', 'ignored'],
            default: 'unmatched',
        },
        quantityInventoried: { type: Number, min: 0, default: 0 },
        inventoryStatus: {
            type: String,
            enum: ['pending', 'applied', 'skipped'],
            default: 'pending',
        },
        inventorySkipReason: { type: String, trim: true },
        note: { type: String, trim: true },
    },
    { _id: false }
);

const PurchaseOrderSchema = new mongoose.Schema(
    {
        orderCode: { type: String, trim: true },
        purchaseRequestIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequest' }],
        purchaseRequestCodes: [{ type: String, trim: true }],
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        status: {
            type: String,
            enum: ['draft', 'confirmed', 'ordered', 'partially_received', 'received', 'cancelled'],
            default: 'draft',
        },
        items: { type: [POItemSchema], default: [] },
        totalAmount: { type: Number, default: 0, min: 0 },
        totalVat: { type: Number, default: 0, min: 0 },
        totalWithVat: { type: Number, default: 0, min: 0 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        orderedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        orderedAt: { type: Date },
        receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        receivedAt: { type: Date },
        cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        cancelledReason: { type: String, trim: true },
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        supplierName: { type: String, trim: true },
        note: { type: String, trim: true },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

PurchaseOrderSchema.index(
    { orderCode: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false, orderCode: { $exists: true, $type: 'string' } } }
);
PurchaseOrderSchema.index({ status: 1, createdAt: -1 });
PurchaseOrderSchema.index({ purchaseRequestIds: 1 });
PurchaseOrderSchema.index({ plantId: 1, status: 1 });
PurchaseOrderSchema.index({ createdAt: -1 });

const PurchaseOrder = mongoose.model('PurchaseOrder', PurchaseOrderSchema);
export default PurchaseOrder;
