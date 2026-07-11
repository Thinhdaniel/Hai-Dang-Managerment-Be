import mongoose from 'mongoose';

const RealityOperationalAlertSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true, index: true },
        code: {
            type: String,
            enum: ['low_score', 'zone_drift', 'stale_evidence', 'coverage_overdue', 'proposal_overdue'],
            required: true,
        },
        activeKey: { type: String, unique: true, sparse: true, trim: true },
        scopeKey: { type: String, required: true, trim: true },
        severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
        status: { type: String, enum: ['open', 'in_progress', 'resolved', 'dismissed'], default: 'open' },
        title: { type: String, required: true, trim: true },
        message: { type: String, required: true, trim: true },
        zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'FloorZone' },
        zoneName: { type: String, trim: true },
        assetIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
        metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
        metricHash: { type: String, trim: true },
        lastNotifiedMetricHash: { type: String, trim: true },
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        dueAt: { type: Date },
        firstDetectedAt: { type: Date, required: true, default: Date.now },
        lastDetectedAt: { type: Date, required: true, default: Date.now },
        lastNotifiedAt: { type: Date },
        occurrenceCount: { type: Number, default: 1, min: 1 },
        resolvedAt: { type: Date },
        resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        resolutionNote: { type: String, trim: true },
    },
    { timestamps: true, versionKey: false }
);

RealityOperationalAlertSchema.index({ plantId: 1, status: 1, severity: 1, updatedAt: -1 });
RealityOperationalAlertSchema.index({ assignedTo: 1, status: 1, dueAt: 1 });

export default mongoose.model('RealityOperationalAlert', RealityOperationalAlertSchema);
