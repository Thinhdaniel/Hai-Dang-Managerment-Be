import mongoose from 'mongoose';

const ProductionQcOpeningBalanceEntrySchema = new mongoose.Schema(
    {
        entryKey: { type: String, required: true, trim: true, maxlength: 220 },
        lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine', required: true },
        lineCode: { type: String, required: true, trim: true, maxlength: 30 },
        lineName: { type: String, trim: true, maxlength: 120 },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem' },
        itemCode: { type: String, trim: true, maxlength: 60 },
        itemName: { type: String, trim: true, maxlength: 200 },
        orderCode: { type: String, trim: true, uppercase: true, maxlength: 80 },
        unit: { type: String, trim: true, maxlength: 30, default: 'SP' },
        mode: { type: String, enum: ['full', 'backlog_only'], required: true, default: 'full' },
        passedQuantity: { type: Number, required: true, min: 0, max: 1_000_000_000 },
        defectQuantity: { type: Number, required: true, min: 0, max: 1_000_000_000 },
        pendingQuantity: { type: Number, required: true, min: 0, max: 1_000_000_000 },
        allocationState: {
            type: String,
            enum: ['exact', 'unallocated'],
            required: true,
            default: 'exact',
        },
        sourceRow: { type: Number, min: 1 },
    },
    { _id: true }
);

const ProductionQcOpeningBalanceHistorySchema = new mongoose.Schema(
    {
        type: { type: String, enum: ['confirmed', 'voided'], required: true },
        reason: { type: String, trim: true, maxlength: 500 },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, required: true, default: Date.now },
    },
    { _id: true }
);

const ProductionQcOpeningBalanceBatchSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, trim: true, uppercase: true, maxlength: 48, unique: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        plantName: { type: String, required: true, trim: true, maxlength: 160 },
        plantCode: { type: String, trim: true, maxlength: 40 },
        cutoffDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        sourceType: { type: String, enum: ['manual', 'excel'], required: true },
        sourceFileName: { type: String, trim: true, maxlength: 255 },
        sourceFileSize: { type: Number, min: 0 },
        sourceSheet: { type: String, trim: true, maxlength: 120 },
        fingerprint: { type: String, required: true, trim: true, maxlength: 128 },
        note: { type: String, required: true, trim: true, maxlength: 500 },
        status: { type: String, enum: ['confirmed', 'voided'], default: 'confirmed', required: true },
        entries: {
            type: [ProductionQcOpeningBalanceEntrySchema],
            required: true,
            validate: {
                validator: (entries: unknown[]) => entries.length > 0 && entries.length <= 2_000,
                message: 'Mỗi đợt cần từ 1 đến 2.000 dòng QC đầu kỳ',
            },
        },
        summary: {
            entryCount: { type: Number, required: true, min: 1 },
            passedQuantity: { type: Number, required: true, min: 0 },
            defectQuantity: { type: Number, required: true, min: 0 },
            inspectedQuantity: { type: Number, required: true, min: 0 },
            pendingQuantity: { type: Number, required: true, min: 0 },
            exactPendingQuantity: { type: Number, required: true, min: 0 },
            unallocatedPendingQuantity: { type: Number, required: true, min: 0 },
            fullEntryCount: { type: Number, required: true, min: 0 },
        },
        confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        confirmedAt: { type: Date, required: true, default: Date.now },
        voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        voidedAt: { type: Date },
        voidReason: { type: String, trim: true, maxlength: 500 },
        history: { type: [ProductionQcOpeningBalanceHistorySchema], default: [] },
    },
    { timestamps: true, versionKey: false }
);

ProductionQcOpeningBalanceBatchSchema.index({ plantId: 1, status: 1, cutoffDate: -1, createdAt: -1 });
ProductionQcOpeningBalanceBatchSchema.index(
    { plantId: 1, fingerprint: 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'confirmed' },
        name: 'active_qc_opening_fingerprint',
    }
);
ProductionQcOpeningBalanceBatchSchema.index(
    { plantId: 1, 'entries.entryKey': 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'confirmed' },
        name: 'active_qc_opening_entry_key',
    }
);

const ProductionQcOpeningBalanceBatch = mongoose.model(
    'ProductionQcOpeningBalanceBatch',
    ProductionQcOpeningBalanceBatchSchema
);

export default ProductionQcOpeningBalanceBatch;
