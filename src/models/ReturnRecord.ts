import mongoose from 'mongoose';

const ReturnItemSchema = new mongoose.Schema(
    {
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        materialName: { type: String, trim: true },
        unit: { type: String, trim: true },
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        supplierName: { type: String, trim: true },
        quantityReturned: { type: Number, required: true, min: 0 },
        unitPrice: { type: Number, min: 0, default: 0 },
        vatRate: { type: Number, min: 0, default: 0 },
        refundAmount: { type: Number, min: 0, default: 0 },      // trước VAT
        refundWithVat: { type: Number, min: 0, default: 0 },     // sau VAT
        reason: { type: String, trim: true },
    },
    { _id: false }
);

const ReturnRecordSchema = new mongoose.Schema(
    {
        returnCode: { type: String, trim: true },
        purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
        purchaseOrderCode: { type: String, trim: true },
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
        supplierName: { type: String, trim: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },   // kho bị trừ (CS1)
        items: { type: [ReturnItemSchema], default: [] },
        totalRefund: { type: Number, min: 0, default: 0 },
        totalRefundWithVat: { type: Number, min: 0, default: 0 },
        returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        returnedAt: { type: Date, default: Date.now },
        note: { type: String, trim: true },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

ReturnRecordSchema.index(
    { returnCode: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false, returnCode: { $exists: true, $type: 'string' } } }
);
ReturnRecordSchema.index({ purchaseOrderId: 1 });
ReturnRecordSchema.index({ createdAt: -1 });

const ReturnRecord = mongoose.model('ReturnRecord', ReturnRecordSchema);
export default ReturnRecord;
