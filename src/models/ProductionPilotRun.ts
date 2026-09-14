import mongoose from 'mongoose';

const ActorSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        name: { type: String, trim: true, maxlength: 160, required: true },
    },
    { _id: false }
);

const SnapshotSchema = new mongoose.Schema(
    {
        capturedAt: { type: Date, required: true },
        capturedBy: { type: ActorSchema, required: true },
        actualOutput: { type: Number, min: 0, required: true },
        plannedOutput: { type: Number, min: 0, required: true },
        openOrders: { type: Number, min: 0, required: true },
        capacityUtilizationPercent: { type: Number, min: 0, max: 1000, required: true },
        materialBlockedOrders: { type: Number, min: 0, required: true },
        forecastLateOrders: { type: Number, min: 0, required: true },
        criticalOrders: { type: Number, min: 0, default: 0 },
        statusMismatchOrders: { type: Number, min: 0, default: 0 },
        planCoveragePercent: { type: Number, min: 0, max: 100, default: 0 },
    },
    { _id: false }
);

const ReferenceSchema = new mongoose.Schema(
    {
        enteredAt: { type: Date, required: true },
        enteredBy: { type: ActorSchema, required: true },
        actualOutput: { type: Number, min: 0, required: true },
        plannedOutput: { type: Number, min: 0, required: true },
        openOrders: { type: Number, min: 0, required: true },
        capacityUtilizationPercent: { type: Number, min: 0, max: 1000, required: true },
        materialBlockedOrders: { type: Number, min: 0, required: true },
        forecastLateOrders: { type: Number, min: 0, required: true },
        sourceSheet: { type: String, trim: true, maxlength: 160 },
        note: { type: String, trim: true, maxlength: 500 },
    },
    { _id: false }
);

const PilotDaySchema = new mongoose.Schema(
    {
        date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        systemSnapshot: { type: SnapshotSchema },
        reference: { type: ReferenceSchema },
        varianceAccepted: { type: Boolean, default: false },
        varianceAcceptanceNote: { type: String, trim: true, maxlength: 500 },
        varianceAcceptedAt: { type: Date },
        varianceAcceptedBy: { type: ActorSchema },
    },
    { _id: true }
);

const ChecklistSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
        category: {
            type: String,
            enum: ['business', 'security', 'reliability', 'data', 'training', 'rollback'],
            required: true,
        },
        title: { type: String, required: true, trim: true, maxlength: 240 },
        description: { type: String, trim: true, maxlength: 500 },
        mandatory: { type: Boolean, default: true },
        status: {
            type: String,
            enum: ['pending', 'passed', 'failed', 'blocked', 'not_applicable'],
            default: 'pending',
        },
        evidence: { type: String, trim: true, maxlength: 1000 },
        updatedAt: { type: Date },
        updatedBy: { type: ActorSchema },
    },
    { _id: false }
);

const LimitationSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true, maxlength: 240 },
        impact: { type: String, required: true, trim: true, maxlength: 1000 },
        mitigation: { type: String, trim: true, maxlength: 1000 },
        owner: { type: String, trim: true, maxlength: 160 },
        dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        severity: { type: String, enum: ['critical', 'high', 'medium', 'low'], required: true },
        status: { type: String, enum: ['open', 'mitigated', 'accepted', 'resolved'], default: 'open' },
        createdAt: { type: Date, default: Date.now, required: true },
        createdBy: { type: ActorSchema, required: true },
        updatedAt: { type: Date },
        updatedBy: { type: ActorSchema },
    },
    { _id: true }
);

const HistorySchema = new mongoose.Schema(
    {
        type: { type: String, required: true, trim: true, maxlength: 80 },
        note: { type: String, trim: true, maxlength: 500 },
        actor: { type: ActorSchema, required: true },
        at: { type: Date, default: Date.now, required: true },
    },
    { _id: true }
);

const ProductionPilotRunSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        plantName: { type: String, required: true, trim: true, maxlength: 160 },
        plantCode: { type: String, trim: true, maxlength: 40 },
        code: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
        name: { type: String, required: true, trim: true, maxlength: 240 },
        sourceFileName: { type: String, trim: true, maxlength: 255 },
        sourceDescription: { type: String, trim: true, maxlength: 500 },
        startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        targetEndDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        status: {
            type: String,
            enum: ['draft', 'active', 'paused', 'ready_for_signoff', 'accepted', 'cancelled'],
            default: 'draft',
        },
        thresholds: {
            minimumShadowDays: { type: Number, min: 1, max: 60, default: 10 },
            quantityVariancePercent: { type: Number, min: 0, max: 100, default: 2 },
            capacityVariancePoints: { type: Number, min: 0, max: 100, default: 3 },
            countVariance: { type: Number, min: 0, max: 1000, default: 0 },
        },
        days: { type: [PilotDaySchema], default: [] },
        checklist: { type: [ChecklistSchema], default: [] },
        knownLimitations: { type: [LimitationSchema], default: [] },
        signoff: {
            signedAt: { type: Date },
            signedBy: { type: ActorSchema },
            note: { type: String, trim: true, maxlength: 1000 },
            version: { type: Number, min: 1 },
        },
        history: { type: [HistorySchema], default: [] },
        revision: { type: Number, min: 0, default: 0 },
        createdBy: { type: ActorSchema, required: true },
        updatedBy: { type: ActorSchema, required: true },
    },
    { timestamps: true, optimisticConcurrency: true }
);

ProductionPilotRunSchema.index({ plantId: 1, code: 1 }, { unique: true });
ProductionPilotRunSchema.index({ plantId: 1, status: 1, startDate: -1 });

export default mongoose.model('ProductionPilotRun', ProductionPilotRunSchema);
