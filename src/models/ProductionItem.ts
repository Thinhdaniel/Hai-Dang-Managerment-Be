import mongoose from 'mongoose';

const ProductionItemPriceSchema = new mongoose.Schema(
    {
        unitPrice: { type: Number, required: true, min: 0 },
        effectiveFrom: { type: Date, required: true },
        effectiveTo: { type: Date },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        changeType: { type: String, enum: ['future_only', 'recalculate_from_date'] },
        effectiveProductionDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        reason: { type: String, trim: true, maxlength: 500 },
        affectedDayCount: { type: Number, min: 0 },
        affectedRunCount: { type: Number, min: 0 },
        affectedEntryCount: { type: Number, min: 0 },
        affectedPlanAllocationCount: { type: Number, min: 0 },
    },
    { _id: false }
);

const ProductionItemOperationTemplateSchema = new mongoose.Schema(
    {
        operationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionOperation', required: true },
        operationCode: { type: String, required: true, trim: true },
        operationName: { type: String, required: true, trim: true },
        unit: { type: String, trim: true, default: 'SP' },
        hourlyQuota: { type: Number, min: 0, default: 0 },
        required: { type: Boolean, default: true },
        sortOrder: { type: Number, min: 0, default: 0 },
    },
    { _id: false }
);

const ProductionItemSchema = new mongoose.Schema(
    {
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            maxlength: 60,
        },
        name: {
            type: String,
            trim: true,
            maxlength: 200,
        },
        unit: {
            type: String,
            trim: true,
            default: 'SP',
            maxlength: 30,
        },
        unitPrice: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
        },
        priceHistory: {
            type: [ProductionItemPriceSchema],
            default: [],
        },
        operationTemplates: {
            type: [ProductionItemOperationTemplateSchema],
            default: [],
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

ProductionItemSchema.index({ plantId: 1, code: 1 }, { unique: true });
ProductionItemSchema.index({ plantId: 1, isActive: 1, code: 1 });

const ProductionItem = mongoose.model('ProductionItem', ProductionItemSchema);

export default ProductionItem;
