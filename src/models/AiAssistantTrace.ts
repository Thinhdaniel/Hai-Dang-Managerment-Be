import mongoose from 'mongoose';
import config from '@/config/env.config';

const AiAssistantToolTraceSchema = new mongoose.Schema(
    {
        tool: { type: String, required: true, trim: true },
        phase: { type: String, enum: ['forced', 'planner', 'react', 'fallback'], required: true },
        args: { type: mongoose.Schema.Types.Mixed, default: {} },
        success: { type: Boolean, required: true },
        durationMs: { type: Number, min: 0, default: 0 },
        records: { type: Number, min: 0 },
        scope: { type: String, trim: true, maxlength: 300 },
        errorCode: { type: String, trim: true, maxlength: 80 },
        errorMessage: { type: String, trim: true, maxlength: 500 },
    },
    { _id: false }
);

const AiAssistantFeedbackSchema = new mongoose.Schema(
    {
        rating: { type: String, enum: ['helpful', 'not_helpful'], required: true },
        reason: {
            type: String,
            enum: ['incorrect', 'misunderstood', 'missing_data', 'too_slow', 'too_verbose', 'other'],
        },
        note: { type: String, trim: true, maxlength: 1000 },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const AiAssistantTraceSchema = new mongoose.Schema(
    {
        reqId: { type: String, required: true, trim: true, unique: true },
        parentReqId: { type: String, trim: true, index: true },
        promptVersion: { type: String, required: true, trim: true },
        toolRegistryVersion: { type: String, required: true, trim: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, trim: true, required: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
        plantName: { type: String, trim: true, maxlength: 180 },
        canAccessProcurement: { type: Boolean, default: false },
        question: { type: String, trim: true, required: true, maxlength: 2200 },
        questionFingerprint: { type: String, required: true, trim: true, maxlength: 64 },
        answerPreview: { type: String, trim: true, maxlength: 4200 },
        answerFingerprint: { type: String, trim: true, maxlength: 64 },
        status: { type: String, enum: ['success', 'policy', 'fallback', 'error'], required: true, index: true },
        tier: { type: String, enum: ['light', 'standard', 'heavy'], required: true },
        provider: { type: String, trim: true, index: true },
        model: { type: String, trim: true, index: true },
        confidence: { type: String, enum: ['high', 'medium', 'low', 'none'] },
        grounding: { type: String, enum: ['verified', 'corrected', 'unverified', 'not_applicable'], index: true },
        groundingIssueCount: { type: Number, min: 0, default: 0 },
        sourceCount: { type: Number, min: 0, default: 0 },
        sources: { type: [mongoose.Schema.Types.Mixed], default: [] },
        planner: {
            used: { type: Boolean, default: false },
            durationMs: { type: Number, min: 0, default: 0 },
            provider: { type: String, trim: true },
            model: { type: String, trim: true },
            goal: { type: String, trim: true, maxlength: 600 },
            steps: { type: [mongoose.Schema.Types.Mixed], default: [] },
            error: { type: String, trim: true, maxlength: 500 },
        },
        tools: { type: [AiAssistantToolTraceSchema], default: [] },
        toolCallCount: { type: Number, min: 0, default: 0 },
        failedToolCount: { type: Number, min: 0, default: 0 },
        actionCount: { type: Number, min: 0, default: 0 },
        actionTypes: { type: [String], default: [] },
        tookMs: { type: Number, min: 0, required: true },
        feedback: { type: AiAssistantFeedbackSchema },
    },
    { timestamps: true, versionKey: false }
);

const ttlDays = config.ai.traceTtlDays;
AiAssistantTraceSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });
AiAssistantTraceSchema.index({ userId: 1, createdAt: -1 });
AiAssistantTraceSchema.index({ createdAt: -1, status: 1 });
AiAssistantTraceSchema.index({ 'feedback.rating': 1, createdAt: -1 });
AiAssistantTraceSchema.index({ 'tools.tool': 1, createdAt: -1 });

const AiAssistantTrace = mongoose.model('AiAssistantTrace', AiAssistantTraceSchema);

export default AiAssistantTrace;
