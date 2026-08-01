import mongoose from 'mongoose';

const ProductionReminderRuleSchema = new mongoose.Schema(
    {
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
            unique: true,
        },
        enabled: { type: Boolean, default: true },
        graceMinutes: { type: Number, min: 0, max: 15, default: 2 },
        repeatMinutes: { type: Number, min: 5, max: 30, default: 5 },
        escalationMinutes: { type: Number, min: 5, max: 120, default: 15 },
        escalateToManagers: { type: Boolean, default: true },
        telegramFallback: { type: Boolean, default: true },
        underTargetEnabled: { type: Boolean, default: true },
        underTargetThreshold: { type: Number, min: 10, max: 100, default: 80 },
        additionalRecipientIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
            default: [],
        },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true, versionKey: false }
);

ProductionReminderRuleSchema.index({ enabled: 1, plantId: 1 });

export default mongoose.model('ProductionReminderRule', ProductionReminderRuleSchema);
