import mongoose from 'mongoose';

const ProductionPlanTimeSlotSchema = new mongoose.Schema(
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

const ProductionPlanAllocationSchema = new mongoose.Schema(
    {
        lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine', required: true },
        lineCode: { type: String, required: true, trim: true },
        lineName: { type: String, trim: true },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem', required: true },
        itemCode: { type: String, required: true, trim: true },
        itemName: { type: String, trim: true },
        unit: { type: String, trim: true, default: 'SP' },
        unitPriceSnapshot: { type: Number, required: true, min: 0 },
        orderCode: { type: String, trim: true, maxlength: 80 },
        plannedQuantity: { type: Number, required: true, min: 1 },
        hourlyQuota: { type: Number, required: true, min: 0.01 },
        startSlotKey: { type: String, required: true, trim: true },
        endSlotKey: { type: String, required: true, trim: true },
        priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
        dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        note: { type: String, trim: true, maxlength: 500 },
        sourceType: { type: String, enum: ['manual', 'carry_over'], default: 'manual' },
        sourcePlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionPlan' },
        sourceAllocationId: { type: mongoose.Schema.Types.ObjectId },
        sourceProductionDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    },
    { _id: true }
);

const ProductionPlanHistorySchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['created', 'updated', 'published', 'reopened', 'carry_over'],
            required: true,
        },
        note: { type: String, trim: true, maxlength: 500 },
        revision: { type: Number, required: true, min: 0 },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, default: Date.now, required: true },
    },
    { _id: true }
);

const ProductionPlanSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        plantName: { type: String, trim: true },
        plantCode: { type: String, trim: true },
        productionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        timeSlots: { type: [ProductionPlanTimeSlotSchema], required: true, default: [] },
        status: { type: String, enum: ['draft', 'published'], default: 'draft' },
        revision: { type: Number, min: 0, default: 0 },
        allocations: { type: [ProductionPlanAllocationSchema], default: [] },
        publishedAt: { type: Date },
        publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reopenedAt: { type: Date },
        reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        lastChangeReason: { type: String, trim: true, maxlength: 500 },
        history: { type: [ProductionPlanHistorySchema], default: [] },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    {
        timestamps: true,
        optimisticConcurrency: true,
    }
);

ProductionPlanSchema.index({ plantId: 1, productionDate: 1 }, { unique: true });
ProductionPlanSchema.index({ plantId: 1, status: 1, productionDate: -1 });
ProductionPlanSchema.index({ 'allocations.sourceAllocationId': 1 }, { sparse: true });

const ProductionPlan = mongoose.model('ProductionPlan', ProductionPlanSchema);

export default ProductionPlan;
