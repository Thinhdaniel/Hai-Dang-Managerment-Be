import mongoose from 'mongoose';

const MaterialSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        code: {
            type: String,
            trim: true,
        },
        category: {
            type: String,
            trim: true,
        },
        unit: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        minStockLevel: {
            type: Number,
            default: 0,
            min: 0,
        },
        trackInventory: {
            type: Boolean,
            default: true,
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
        isDeleted: {
            type: Boolean,
            default: false,
        },
        deletedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

MaterialSchema.index(
    { code: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            code: { $exists: true, $type: 'string' },
        },
    }
);
MaterialSchema.index({ name: 1 });
MaterialSchema.index({ category: 1 });
MaterialSchema.index({ isActive: 1 });

const Material = mongoose.model('Material', MaterialSchema);

export default Material;
