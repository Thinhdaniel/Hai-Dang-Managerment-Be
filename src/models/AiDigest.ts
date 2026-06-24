import mongoose from 'mongoose';

// Bản tin AI định kỳ cho giám đốc. 1 bản / (loại kỳ + mã kỳ) — upsert, cache lại để xem không tốn AI.
const AiDigestSchema = new mongoose.Schema(
    {
        periodType: { type: String, enum: ['week', 'month'], required: true },
        periodKey: { type: String, required: true, trim: true }, // '2026-W26' | '2026-06'
        periodLabel: { type: String, trim: true }, // 'Tuần 23-29/06/2026'
        rangeStart: { type: Date },
        rangeEnd: { type: Date },
        snapshot: { type: mongoose.Schema.Types.Mixed, default: {} }, // số liệu thật đã tính
        narrative: { type: String, trim: true }, // bản tin chính (AI viết)
        highlights: { type: [String], default: [] },
        alerts: { type: [String], default: [] },
        recommendations: { type: [String], default: [] },
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = tự động (cron)
    },
    { timestamps: true, versionKey: false }
);

AiDigestSchema.index({ periodType: 1, periodKey: 1 }, { unique: true });
AiDigestSchema.index({ periodType: 1, createdAt: -1 });

const AiDigest = mongoose.model('AiDigest', AiDigestSchema);

export default AiDigest;
