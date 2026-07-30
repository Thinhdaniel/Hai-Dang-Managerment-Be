import mongoose from 'mongoose';

const ProductionOpeningBalanceEntrySchema = new mongoose.Schema(
    {
        entryKey: { type: String, required: true, trim: true, maxlength: 200 },
        lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine', required: true },
        lineCode: { type: String, required: true, trim: true, maxlength: 30 },
        lineName: { type: String, trim: true, maxlength: 120 },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem' },
        itemCode: { type: String, trim: true, maxlength: 60 },
        itemName: { type: String, trim: true, maxlength: 200 },
        orderCode: { type: String, trim: true, maxlength: 80 },
        unit: { type: String, trim: true, maxlength: 30, default: 'SP' },
        quantity: { type: Number, required: true, min: 0.01, max: 1_000_000_000 },
        unitPriceSnapshot: { type: Number, min: 0, max: 1_000_000_000 },
        amountSnapshot: { type: Number, min: 0, max: 1_000_000_000_000_000 },
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

const ProductionOpeningBalanceHistorySchema = new mongoose.Schema(
    {
        type: { type: String, enum: ['confirmed', 'voided'], required: true },
        reason: { type: String, trim: true, maxlength: 500 },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, required: true, default: Date.now },
    },
    { _id: true }
);

const ProductionOpeningBalanceBatchSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40, unique: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        plantName: { type: String, required: true, trim: true, maxlength: 160 },
        plantCode: { type: String, trim: true, maxlength: 40 },
        cutoffDate: {
            type: String,
            required: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },
        sourceType: { type: String, enum: ['manual', 'excel'], required: true },
        sourceFileName: { type: String, trim: true, maxlength: 255 },
        sourceFileSize: { type: Number, min: 0 },
        sourceSheet: { type: String, trim: true, maxlength: 120 },
        fingerprint: { type: String, required: true, trim: true, maxlength: 128 },
        note: { type: String, trim: true, maxlength: 500 },
        status: { type: String, enum: ['confirmed', 'voided'], default: 'confirmed', required: true },
        entries: {
            type: [ProductionOpeningBalanceEntrySchema],
            required: true,
            validate: {
                validator: (entries: unknown[]) => entries.length > 0 && entries.length <= 2_000,
                message: 'Mỗi đợt cần từ 1 đến 2.000 dòng sản lượng đầu kỳ',
            },
        },
        summary: {
            entryCount: { type: Number, required: true, min: 1 },
            totalQuantity: { type: Number, required: true, min: 0 },
            exactQuantity: { type: Number, required: true, min: 0 },
            unallocatedQuantity: { type: Number, required: true, min: 0 },
            valuedQuantity: { type: Number, required: true, min: 0 },
            totalAmount: { type: Number, required: true, min: 0 },
        },
        confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        confirmedAt: { type: Date, required: true, default: Date.now },
        voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        voidedAt: { type: Date },
        voidReason: { type: String, trim: true, maxlength: 500 },
        history: { type: [ProductionOpeningBalanceHistorySchema], default: [] },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

ProductionOpeningBalanceBatchSchema.index({ plantId: 1, status: 1, cutoffDate: -1, createdAt: -1 });
ProductionOpeningBalanceBatchSchema.index(
    { plantId: 1, fingerprint: 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'confirmed' },
        name: 'active_opening_balance_fingerprint',
    }
);
ProductionOpeningBalanceBatchSchema.index(
    { plantId: 1, 'entries.entryKey': 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'confirmed' },
        name: 'active_opening_balance_entry_key',
    }
);

const ProductionOpeningBalanceBatch = mongoose.model(
    'ProductionOpeningBalanceBatch',
    ProductionOpeningBalanceBatchSchema
);

export default ProductionOpeningBalanceBatch;
