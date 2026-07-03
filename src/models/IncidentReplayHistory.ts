import mongoose from 'mongoose';

const IncidentReplayFeedbackSchema = new mongoose.Schema(
    {
        rating: {
            type: String,
            enum: ['accurate', 'wrong', 'missing_data', 'irrelevant'],
            required: true,
        },
        note: { type: String, trim: true, maxlength: 1000 },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const IncidentReplayAuditSchema = new mongoose.Schema(
    {
        action: {
            type: String,
            enum: ['created', 'reviewed', 'approved', 'closed', 'reopened', 'feedback'],
            required: true,
        },
        note: { type: String, trim: true, maxlength: 2000 },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        userName: { type: String, trim: true },
        at: { type: Date, default: Date.now },
    },
    { _id: false }
);

const IncidentReplayHistorySchema = new mongoose.Schema(
    {
        sessionId: { type: String, trim: true, index: true },
        version: { type: Number, default: 6 },
        question: { type: String, trim: true, required: true },
        focus: { type: String, trim: true },
        periodDays: { type: Number, min: 1 },
        periodLabel: { type: String, trim: true },
        previousPeriodLabel: { type: String, trim: true },
        caseScore: { type: Number, min: 0, max: 100 },
        caseSeverity: { type: String, enum: ['normal', 'watch', 'high', 'critical'] },
        scope: { type: mongoose.Schema.Types.Mixed },
        metrics: { type: mongoose.Schema.Types.Mixed },
        drivers: { type: mongoose.Schema.Types.Mixed },
        breakdowns: { type: mongoose.Schema.Types.Mixed },
        anomalies: { type: mongoose.Schema.Types.Mixed },
        rootCauseChains: { type: mongoose.Schema.Types.Mixed },
        recommendations: { type: mongoose.Schema.Types.Mixed },
        events: { type: mongoose.Schema.Types.Mixed },
        flags: { type: [String], default: [] },
        narrative: { type: String },
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        aiUsed: { type: Boolean, default: false },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        workflowStatus: {
            type: String,
            enum: ['draft', 'reviewed', 'approved', 'closed'],
            default: 'draft',
            index: true,
        },
        reviewNote: { type: String, trim: true, maxlength: 3000 },
        managerConclusion: { type: String, trim: true, maxlength: 3000 },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedByName: { type: String, trim: true },
        reviewedAt: { type: Date },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        approvedByName: { type: String, trim: true },
        approvedAt: { type: Date },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        closedByName: { type: String, trim: true },
        closedAt: { type: Date },
        auditTrail: { type: [IncidentReplayAuditSchema], default: [] },
        feedback: { type: IncidentReplayFeedbackSchema },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

IncidentReplayHistorySchema.index({ createdBy: 1, createdAt: -1 });
IncidentReplayHistorySchema.index({ caseSeverity: 1, createdAt: -1 });
IncidentReplayHistorySchema.index({ isDeleted: 1, createdAt: -1 });
IncidentReplayHistorySchema.index({ workflowStatus: 1, updatedAt: -1 });

const IncidentReplayHistory = mongoose.model('IncidentReplayHistory', IncidentReplayHistorySchema);

export default IncidentReplayHistory;
