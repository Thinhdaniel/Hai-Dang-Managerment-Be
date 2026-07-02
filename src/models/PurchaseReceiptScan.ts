import mongoose from 'mongoose';

const PurchaseReceiptScanSchema = new mongoose.Schema(
    {
        purchaseOrderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PurchaseOrder',
            required: true,
            index: true,
        },
        purchaseOrderCode: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: ['preview', 'applied', 'discarded'],
            default: 'preview',
            index: true,
        },
        fileCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        header: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        extractedLines: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },
        currentAllocations: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },
        shortageAllocations: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },
        reviewLines: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },
        shortageMarks: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },
        proposedPayload: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        appliedPayload: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },
        summary: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        provider: {
            type: String,
            trim: true,
        },
        model: {
            type: String,
            trim: true,
        },
        latencyMs: {
            type: Number,
            min: 0,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        appliedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        appliedAt: {
            type: Date,
        },
    },
    { timestamps: true, versionKey: false }
);

PurchaseReceiptScanSchema.index({ purchaseOrderId: 1, createdAt: -1 });
PurchaseReceiptScanSchema.index({ createdBy: 1, createdAt: -1 });

const PurchaseReceiptScan = mongoose.model('PurchaseReceiptScan', PurchaseReceiptScanSchema);

export default PurchaseReceiptScan;
