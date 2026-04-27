import mongoose from 'mongoose';

const BrandSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        normalizedName: {
            type: String,
            required: true,
            trim: true,
            select: false,
        },
        description: {
            type: String,
            trim: true,
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

BrandSchema.index(
    { normalizedName: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            normalizedName: { $exists: true },
        },
    }
);

const Brand = mongoose.model('Brand', BrandSchema);

export default Brand;
