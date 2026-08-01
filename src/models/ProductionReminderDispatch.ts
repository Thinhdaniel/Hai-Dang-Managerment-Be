import mongoose from 'mongoose';

const ProductionReminderDispatchSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        bucketKey: { type: String, required: true, trim: true, maxlength: 80 },
        trigger: {
            type: String,
            enum: ['schedule', 'startup', 'internal', 'manual'],
            default: 'schedule',
        },
        status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
        startedAt: { type: Date, default: Date.now, required: true },
        completedAt: { type: Date },
        errorMessage: { type: String, trim: true, maxlength: 500 },
        summary: { type: mongoose.Schema.Types.Mixed, default: {} },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true, versionKey: false }
);

ProductionReminderDispatchSchema.index(
    { plantId: 1, bucketKey: 1 },
    { unique: true, name: 'production_reminder_dispatch_bucket' }
);
ProductionReminderDispatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ProductionReminderDispatch', ProductionReminderDispatchSchema);
