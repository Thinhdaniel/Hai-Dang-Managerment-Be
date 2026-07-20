import mongoose from 'mongoose';

const ProductionItemPriceSchema = new mongoose.Schema(
    {
        unitPrice: { type: Number, required: true, min: 0 },
        effectiveFrom: { type: Date, required: true },
        effectiveTo: { type: Date },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
