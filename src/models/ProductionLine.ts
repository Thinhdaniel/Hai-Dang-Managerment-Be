import mongoose from 'mongoose';

const ProductionLineSchema = new mongoose.Schema(
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
            maxlength: 30,
        },
        name: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        leaderName: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        sortOrder: {
            type: Number,
            default: 0,
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

ProductionLineSchema.index({ plantId: 1, code: 1 }, { unique: true });
ProductionLineSchema.index({ plantId: 1, isActive: 1, sortOrder: 1 });

const ProductionLine = mongoose.model('ProductionLine', ProductionLineSchema);

export default ProductionLine;
