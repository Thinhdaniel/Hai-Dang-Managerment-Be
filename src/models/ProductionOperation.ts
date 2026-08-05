import mongoose from 'mongoose';

const ProductionOperationSchema = new mongoose.Schema(
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
            maxlength: 40,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 160,
        },
        unit: {
            type: String,
            trim: true,
            default: 'SP',
            maxlength: 30,
        },
        sortOrder: {
            type: Number,
            default: 0,
            min: 0,
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

ProductionOperationSchema.index({ plantId: 1, code: 1 }, { unique: true });
ProductionOperationSchema.index({ plantId: 1, isActive: 1, sortOrder: 1, code: 1 });

const ProductionOperation = mongoose.model('ProductionOperation', ProductionOperationSchema);

export default ProductionOperation;
