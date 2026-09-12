import mongoose from 'mongoose';

const ProductionScheduleTimeSlotSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, trim: true, maxlength: 24 },
        label: { type: String, required: true, trim: true, maxlength: 30 },
        startMinute: { type: Number, required: true, min: 0, max: 1439 },
        endMinute: { type: Number, required: true, min: 1, max: 1440 },
        kind: { type: String, enum: ['regular', 'overtime'], default: 'regular' },
        isActive: { type: Boolean, default: true },
    },
    { _id: false }
);

const ProductionScheduleTemplateSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        weekday: { type: Number, required: true, min: 0, max: 6 },
        isWorkingDay: { type: Boolean, default: true },
        timeSlots: { type: [ProductionScheduleTimeSlotSchema], required: true, default: [] },
        revision: { type: Number, min: 0, default: 0 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true, versionKey: false }
);

ProductionScheduleTemplateSchema.index({ plantId: 1, weekday: 1 }, { unique: true });
ProductionScheduleTemplateSchema.index({ plantId: 1, updatedAt: -1 });

export default mongoose.model('ProductionScheduleTemplate', ProductionScheduleTemplateSchema);
