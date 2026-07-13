import mongoose from 'mongoose';

const DigestVisualSchema = new mongoose.Schema(
    {
        status: {
            type: String,
            enum: ['disabled', 'pending', 'ready', 'fallback', 'custom', 'failed'],
            default: 'disabled',
        },
        coverImageUrl: { type: String, trim: true },
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        generatedAt: { type: Date },
        promptVersion: { type: String, trim: true },
        error: { type: String, trim: true },
        aiGenerated: { type: Boolean, default: false },
    },
    { _id: false }
);

const DigestEditorialSchema = new mongoose.Schema(
    {
        hiddenIncidentIds: { type: [String], default: [] },
        hiddenRepairIds: { type: [String], default: [] },
        hiddenMaterialKeys: { type: [String], default: [] },
        hiddenPlantIds: { type: [String], default: [] },
        lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        lastEditedAt: { type: Date },
    },
    { _id: false }
);

const DigestValidationIssueSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, trim: true },
        severity: { type: String, enum: ['critical', 'warning', 'info'], required: true },
        title: { type: String, required: true, trim: true },
        detail: { type: String, trim: true },
        actionUrl: { type: String, trim: true },
        refType: { type: String, trim: true },
        refId: { type: String, trim: true },
    },
    { _id: false }
);

const DigestValidationSchema = new mongoose.Schema(
    {
        status: { type: String, enum: ['unchecked', 'passed', 'warning', 'blocked'], default: 'unchecked' },
        issues: { type: [DigestValidationIssueSchema], default: [] },
        checkedAt: { type: Date },
        checksum: { type: String, trim: true },
    },
    { _id: false }
);

const DigestArtifactSchema = new mongoose.Schema(
    {
        status: { type: String, enum: ['none', 'generating', 'ready', 'failed'], default: 'none' },
        publicId: { type: String, trim: true },
        fileName: { type: String, trim: true },
        checksum: { type: String, trim: true },
        bytes: { type: Number, min: 0 },
        version: { type: Number, min: 1 },
        contentRevision: { type: Number, min: 0 },
        generatedAt: { type: Date },
        error: { type: String, trim: true },
    },
    { _id: false }
);

const DigestDeliverySchema = new mongoose.Schema(
    {
        expectedRecipients: { type: Number, default: 0, min: 0 },
        inAppCreated: { type: Number, default: 0, min: 0 },
        webPushSent: { type: Number, default: 0, min: 0 },
        telegramSent: { type: Number, default: 0, min: 0 },
        failedChannels: { type: Number, default: 0, min: 0 },
        deliveredAt: { type: Date },
    },
    { _id: false }
);

const DigestViewReceiptSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        firstViewedAt: { type: Date, required: true },
        lastViewedAt: { type: Date, required: true },
        viewCount: { type: Number, default: 1, min: 1 },
    },
    { _id: false }
);

const DigestEditHistorySchema = new mongoose.Schema(
    {
        editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        editedAt: { type: Date, required: true },
        changedFields: { type: [String], default: [] },
        note: { type: String, trim: true },
        previous: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { _id: false }
);

// Giữ các bản trước ngay trong document theo kỳ để không phải thay unique index
// đang chạy trên production. Chỉ lưu tối đa 12 revision gần nhất ở service.
const DigestRevisionSchema = new mongoose.Schema(
    {
        version: { type: Number, required: true },
        status: { type: String, trim: true },
        snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
        narrative: { type: String, trim: true },
        highlights: { type: [String], default: [] },
        alerts: { type: [String], default: [] },
        recommendations: { type: [String], default: [] },
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        visual: { type: DigestVisualSchema, default: undefined },
        editorial: { type: DigestEditorialSchema, default: undefined },
        validation: { type: DigestValidationSchema, default: undefined },
        artifact: { type: DigestArtifactSchema, default: undefined },
        delivery: { type: DigestDeliverySchema, default: undefined },
        contentRevision: { type: Number, default: 0 },
        editHistory: { type: [DigestEditHistorySchema], default: [] },
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        generatedAt: { type: Date, required: true },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        approvedAt: { type: Date },
        approvalNote: { type: String, trim: true },
        publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        publishedAt: { type: Date },
    },
    { _id: false }
);

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
        dataWarnings: { type: [String], default: [] },
        provider: { type: String, trim: true },
        model: { type: String, trim: true },
        visual: { type: DigestVisualSchema, default: undefined },
        editorial: { type: DigestEditorialSchema, default: undefined },
        validation: { type: DigestValidationSchema, default: undefined },
        artifact: { type: DigestArtifactSchema, default: undefined },
        delivery: { type: DigestDeliverySchema, default: undefined },
        contentRevision: { type: Number, default: 0, min: 0 },
        editHistory: { type: [DigestEditHistorySchema], default: [] },
        viewReceipts: { type: [DigestViewReceiptSchema], default: [] },
        status: {
            type: String,
            enum: ['draft', 'approved', 'published'],
            default: 'draft',
            index: true,
        },
        version: { type: Number, default: 1, min: 1 },
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = tự động (cron)
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        approvedAt: { type: Date },
        approvalNote: { type: String, trim: true },
        publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        publishedAt: { type: Date },
        revisionHistory: { type: [DigestRevisionSchema], default: [] },
    },
    { timestamps: true, versionKey: false }
);

AiDigestSchema.index({ periodType: 1, periodKey: 1 }, { unique: true });
AiDigestSchema.index({ periodType: 1, createdAt: -1 });

const AiDigest = mongoose.model('AiDigest', AiDigestSchema);

export default AiDigest;
