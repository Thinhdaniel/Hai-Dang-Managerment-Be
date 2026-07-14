import mongoose from 'mongoose';

const BriefingContentItemSchema = new mongoose.Schema(
    {
        id: { type: String, required: true, trim: true },
        title: { type: String, required: true, trim: true },
        detail: { type: String, required: true, trim: true },
        severity: {
            type: String,
            enum: ['positive', 'info', 'warning', 'critical'],
            default: 'info',
        },
        evidenceKeys: { type: [String], default: [] },
        actionKey: { type: String, trim: true },
        actionLabel: { type: String, trim: true },
        actionUrl: { type: String, trim: true },
    },
    { _id: false }
);

const ExecutiveBriefingSchema = new mongoose.Schema(
    {
        periodType: { type: String, enum: ['week', 'month'], required: true },
        periodKey: { type: String, required: true, trim: true },
        periodLabel: { type: String, required: true, trim: true },
        rangeStart: { type: Date, required: true },
        rangeEnd: { type: Date, required: true },
        comparisonKey: { type: String, required: true, trim: true },
        comparisonLabel: { type: String, required: true, trim: true },
        comparisonStart: { type: Date, required: true },
        comparisonEnd: { type: Date, required: true },
        dataAsOf: { type: Date, required: true },
        snapshotVersion: { type: Number, default: 1, min: 1 },
        sourceHash: { type: String, required: true, trim: true },
        snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
        summary: { type: String, required: true, trim: true },
        highlights: { type: [BriefingContentItemSchema], default: [] },
        risks: { type: [BriefingContentItemSchema], default: [] },
        actions: { type: [BriefingContentItemSchema], default: [] },
        generationStatus: {
            type: String,
            enum: ['ready', 'degraded'],
            default: 'ready',
        },
        trigger: {
            type: String,
            enum: ['cron', 'startup', 'manual', 'internal'],
            default: 'cron',
        },
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        latencyMs: { type: Number, min: 0 },
        fallbackCode: {
            type: String,
            enum: ['ai_disabled', 'authentication', 'quota', 'timeout', 'invalid_response', 'provider_unavailable'],
        },
        fallbackReason: { type: String, trim: true, maxlength: 240 },
        aiAttemptedAt: { type: Date },
        nextAiRetryAt: { type: Date },
        version: { type: Number, default: 1, min: 1 },
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        notifiedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

ExecutiveBriefingSchema.index({ periodType: 1, periodKey: 1 }, { unique: true });
ExecutiveBriefingSchema.index({ periodType: 1, rangeEnd: -1 });

const ExecutiveBriefing = mongoose.model('ExecutiveBriefing', ExecutiveBriefingSchema);

export default ExecutiveBriefing;
