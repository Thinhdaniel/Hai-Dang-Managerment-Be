import mongoose from 'mongoose';

const LineAssignmentSchema = new mongoose.Schema(
    {
        lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine', required: true },
        lineCode: { type: String, required: true },
        lineName: { type: String },
        quantity: { type: Number, required: true, min: 1 },
        startDate: { type: String, required: true },
        dueDate: { type: String, required: true },
    },
    { _id: false }
);

const ProductionOrderHistorySchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['created', 'updated', 'status_changed', 'imported'],
            required: true,
        },
        fromStatus: { type: String },
        toStatus: { type: String },
        note: { type: String, trim: true, maxlength: 500 },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        at: { type: Date, default: Date.now, required: true },
        previousAssignments: { type: [LineAssignmentSchema], default: undefined },
        nextAssignments: { type: [LineAssignmentSchema], default: undefined },
    },
    { _id: true }
);

const ProductionOrderSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        plantName: { type: String, trim: true, maxlength: 160 },
        plantCode: { type: String, trim: true, maxlength: 40 },
        code: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
        customerName: { type: String, trim: true, maxlength: 160 },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem', required: true },
        itemCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
        itemName: { type: String, trim: true, maxlength: 200 },
        unit: { type: String, trim: true, maxlength: 30, default: 'SP' },
        totalQuantity: { type: Number, required: true, min: 1, max: 1_000_000_000 },
        lineAssignments: { type: [LineAssignmentSchema], default: [] },
        plannedStartDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
        status: {
            type: String,
            enum: ['draft', 'ready', 'in_production', 'paused', 'completed', 'cancelled'],
            default: 'draft',
        },
        note: { type: String, trim: true, maxlength: 500 },
        sourceType: { type: String, enum: ['manual', 'excel'], default: 'manual' },
        sourceFileName: { type: String, trim: true, maxlength: 255 },
        revision: { type: Number, min: 0, default: 0 },
        history: { type: [ProductionOrderHistorySchema], default: [] },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    {
        timestamps: true,
        optimisticConcurrency: true,
    }
);

ProductionOrderSchema.index({ plantId: 1, code: 1 }, { unique: true });
ProductionOrderSchema.index({ plantId: 1, status: 1, dueDate: 1 });
ProductionOrderSchema.index({ plantId: 1, itemId: 1, status: 1 });
ProductionOrderSchema.index({ plantId: 1, customerName: 1 });

const ProductionOrder = mongoose.model('ProductionOrder', ProductionOrderSchema);

export default ProductionOrder;
