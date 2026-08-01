import mongoose from 'mongoose';

const ReminderDeliverySchema = new mongoose.Schema(
    {
        attemptedRecipients: { type: Number, default: 0, min: 0 },
        inAppCreated: { type: Number, default: 0, min: 0 },
        webPushSent: { type: Number, default: 0, min: 0 },
        telegramSent: { type: Number, default: 0, min: 0 },
        failedChannels: { type: Number, default: 0, min: 0 },
        at: { type: Date },
    },
    { _id: false }
);

const ProductionReminderEventSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        dayId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionDay', required: true },
        productionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        slotKey: { type: String, required: true, trim: true, maxlength: 24 },
        slotLabel: { type: String, required: true, trim: true, maxlength: 60 },
        dueAt: { type: Date, required: true },
        state: {
            type: String,
            enum: ['open', 'resolved', 'expired'],
            default: 'open',
            required: true,
        },
        missingLineIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
        missingLineCodes: { type: [String], default: [] },
        underTargetLineCodes: { type: [String], default: [] },
        firstDetectedAt: { type: Date, default: Date.now, required: true },
        lastDetectedAt: { type: Date, default: Date.now, required: true },
        lastNotifiedAt: { type: Date },
        nextNotifyAt: { type: Date },
        reminderCount: { type: Number, default: 0, min: 0 },
        escalatedAt: { type: Date },
        performanceNotifiedAt: { type: Date },
        resolvedAt: { type: Date },
        resolutionReason: { type: String, trim: true, maxlength: 120 },
        lastDelivery: { type: ReminderDeliverySchema, default: () => ({}) },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true, versionKey: false }
);

ProductionReminderEventSchema.index(
    { plantId: 1, productionDate: 1, slotKey: 1 },
    { unique: true, name: 'production_reminder_slot' }
);
ProductionReminderEventSchema.index({ plantId: 1, productionDate: 1, state: 1, nextNotifyAt: 1 });
ProductionReminderEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ProductionReminderEvent', ProductionReminderEventSchema);
