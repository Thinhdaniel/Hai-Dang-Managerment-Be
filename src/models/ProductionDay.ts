import mongoose from 'mongoose';

const ProductionTimeSlotSchema = new mongoose.Schema(
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

const ProductionDayStatusEventSchema = new mongoose.Schema(
    {
        from: { type: String, enum: ['draft', 'submitted', 'locked'], required: true },
        to: { type: String, enum: ['draft', 'submitted', 'locked'], required: true },
        note: { type: String, trim: true, maxlength: 500 },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, default: Date.now, required: true },
    },
    { _id: true }
);

const ProductionDaySchema = new mongoose.Schema(
    {
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        plantName: { type: String, trim: true },
        plantCode: { type: String, trim: true },
        productionDate: {
            type: String,
            required: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },
        timeSlots: {
            type: [ProductionTimeSlotSchema],
            required: true,
            default: [],
        },
        status: {
            type: String,
            enum: ['draft', 'submitted', 'locked'],
            default: 'draft',
        },
        submittedAt: { type: Date },
        submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        lockedAt: { type: Date },
        lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reopenedAt: { type: Date },
        reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        statusNote: { type: String, trim: true, maxlength: 500 },
        statusHistory: { type: [ProductionDayStatusEventSchema], default: [] },
        // Đánh dấu đã xếp biên chế chuyền cho ngày này. Có mốc rồi thì không seed lại
        // danh mục chuyền nữa, kể cả khi người dùng gỡ hết chuyền ra.
        lineRosterSeededAt: { type: Date },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

ProductionDaySchema.index({ plantId: 1, productionDate: 1 }, { unique: true });
ProductionDaySchema.index({ productionDate: -1, plantId: 1 });

const ProductionDay = mongoose.model('ProductionDay', ProductionDaySchema);

export default ProductionDay;
