import mongoose from 'mongoose';

const MaintenanceSchema = new mongoose.Schema(
    {
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        type: {
            type: String,
            enum: ['periodic', 'emergency', 'inspection'],
            required: true,
        },
        status: {
            type: String,
            enum: ['pending', 'in_progress', 'completed', 'overdue'],
            default: 'in_progress',
        },
        description: {
            type: String,
            required: true,
            trim: true,
        },
        startDate: {
            type: Date,
            required: true,
        },
        endDate: {
            type: Date,
        },
        technician: {
            type: String,
            trim: true,
        },
        cost: {
            type: Number,
            min: 0,
        },
        note: {
            type: String,
            trim: true,
        },
        createdBy: {
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

MaintenanceSchema.index({ assetId: 1 });
MaintenanceSchema.index({ status: 1 });
MaintenanceSchema.index({ type: 1 });

const Maintenance = mongoose.model('Maintenance', MaintenanceSchema);

export default Maintenance;
