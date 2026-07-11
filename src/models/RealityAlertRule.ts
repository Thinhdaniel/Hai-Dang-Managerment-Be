import mongoose from 'mongoose';

const RealityAlertRuleSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true, unique: true },
        enabled: { type: Boolean, default: true },
        staleDays: { type: Number, default: 30, min: 7, max: 180 },
        minScore: { type: Number, default: 65, min: 0, max: 100 },
        driftThreshold: { type: Number, default: 1, min: 1, max: 1000 },
        stalePercentThreshold: { type: Number, default: 25, min: 1, max: 100 },
        coverageOverdueDays: { type: Number, default: 30, min: 1, max: 365 },
        proposalOverdueDays: { type: Number, default: 3, min: 1, max: 90 },
        cooldownHours: { type: Number, default: 24, min: 1, max: 168 },
        defaultAssignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true, versionKey: false }
);

export default mongoose.model('RealityAlertRule', RealityAlertRuleSchema);
