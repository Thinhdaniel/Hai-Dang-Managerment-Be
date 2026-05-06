import mongoose from 'mongoose';

const SupplierSchema = new mongoose.Schema(
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
        contactName: {
            type: String,
            trim: true,
        },
        phone: {
            type: String,
            trim: true,
        },
        address: {
            type: String,
            trim: true,
        },
        supplyTypes: {
            type: [
                {
                    type: String,
                    enum: ['machine', 'material'],
                    trim: true,
                },
            ],
            default: ['material'],
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

SupplierSchema.index(
    { code: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            code: { $exists: true, $type: 'string' },
        },
    }
);
SupplierSchema.index({ name: 1 });
SupplierSchema.index({ isActive: 1 });
SupplierSchema.index({ supplyTypes: 1 });

const Supplier = mongoose.model('Supplier', SupplierSchema);

export default Supplier;
