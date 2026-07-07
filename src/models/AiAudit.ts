import mongoose from 'mongoose';

// Kiểm toán đêm: mỗi ngày 1 bản (upsert theo runKey) — rule-check cứng + AI săn bất thường chéo.
const AiAuditFindingSchema = new mongoose.Schema(
    {
        code: { type: String, trim: true }, // mã rule (multi_label, negative_stock...) hoặc 'ai'
        source: { type: String, enum: ['rule', 'ai'], default: 'rule' },
        severity: { type: String, enum: ['critical', 'warning', 'info'], default: 'info' },
        title: { type: String, trim: true },
        detail: { type: String, trim: true },
        refs: { type: [String], default: [] }, // mã máy / mã lệnh / publicId liên quan
    },
    { _id: false }
);

const AiAuditSchema = new mongoose.Schema(
    {
        runKey: { type: String, required: true, trim: true }, // '2026-07-08'
        runAt: { type: Date, default: Date.now },
        trigger: { type: String, enum: ['cron', 'manual'], default: 'cron' },
        summary: { type: String, trim: true }, // nhận định tổng quan (AI viết)
        findings: { type: [AiAuditFindingSchema], default: [] },
        recommendations: { type: [String], default: [] },
        stats: { type: mongoose.Schema.Types.Mixed, default: {} }, // số bản ghi đã rà
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = cron
    },
    { timestamps: true, versionKey: false }
);

AiAuditSchema.index({ runKey: 1 }, { unique: true });
AiAuditSchema.index({ createdAt: -1 });

const AiAudit = mongoose.model('AiAudit', AiAuditSchema);

export default AiAudit;
