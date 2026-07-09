import mongoose from 'mongoose';

const LuckyWheelParticipantSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 160 },
        code: { type: String, trim: true, maxlength: 80 },
        department: { type: String, trim: true, maxlength: 160 },
        plantName: { type: String, trim: true, maxlength: 160 },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        weight: { type: Number, min: 1, max: 100, default: 1 },
        active: { type: Boolean, default: true },
    },
    { _id: true, versionKey: false }
);

const LuckyWheelWinnerSchema = new mongoose.Schema(
    {
        participantId: { type: mongoose.Schema.Types.ObjectId },
        name: { type: String, required: true, trim: true, maxlength: 160 },
        code: { type: String, trim: true, maxlength: 80 },
        department: { type: String, trim: true, maxlength: 160 },
        plantName: { type: String, trim: true, maxlength: 160 },
        spinNo: { type: Number, required: true, min: 1 },
        poolSize: { type: Number, required: true, min: 1 },
        randomIndex: { type: Number, required: true, min: 0 },
        spunBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        spunByName: { type: String, trim: true },
        spunAt: { type: Date, default: Date.now },
    },
    { _id: true, versionKey: false }
);

const LuckyWheelSettingsSchema = new mongoose.Schema(
    {
        removeWinnerAfterSpin: { type: Boolean, default: true },
        allowRepeatWinners: { type: Boolean, default: false },
        spinDurationMs: { type: Number, min: 3500, max: 15000, default: 8000 },
        theme: {
            type: String,
            enum: ['haidang-night', 'gold-night', 'tet', 'ocean'],
            default: 'haidang-night',
        },
        soundEnabled: { type: Boolean, default: true },
        confettiEnabled: { type: Boolean, default: true },
    },
    { _id: false }
);

const LuckyWheelEventSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 180 },
        description: { type: String, trim: true, maxlength: 1000 },
        status: {
            type: String,
            enum: ['draft', 'active', 'finished', 'archived'],
            default: 'active',
            index: true,
        },
        participants: { type: [LuckyWheelParticipantSchema], default: [] },
        winners: { type: [LuckyWheelWinnerSchema], default: [] },
        settings: { type: LuckyWheelSettingsSchema, default: () => ({}) },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdByName: { type: String, trim: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

LuckyWheelEventSchema.index({ createdAt: -1 });
LuckyWheelEventSchema.index({ isDeleted: 1, status: 1, updatedAt: -1 });

const LuckyWheelEvent = mongoose.model('LuckyWheelEvent', LuckyWheelEventSchema);

export default LuckyWheelEvent;
