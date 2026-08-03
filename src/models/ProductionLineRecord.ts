import mongoose from 'mongoose';

const ProductionRunSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem', required: true },
        itemCode: { type: String, required: true, trim: true },
        itemName: { type: String, trim: true },
        unit: { type: String, trim: true, default: 'SP' },
        unitPriceSnapshot: { type: Number, required: true, min: 0 },
        hourlyQuota: { type: Number, required: true, min: 0 },
        startedSlotKey: { type: String, required: true, trim: true },
        endedSlotKey: { type: String, trim: true },
        status: { type: String, enum: ['planned', 'active', 'closed'], default: 'active' },
        source: { type: String, enum: ['manual', 'plan'], default: 'manual' },
        planAllocationId: { type: mongoose.Schema.Types.ObjectId },
        plannedQuantity: { type: Number, min: 0 },
        plannedEndSlotKey: { type: String, trim: true },
        orderCode: { type: String, trim: true, maxlength: 80 },
        priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
        dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: true }
);

const HourlyProductionEntrySchema = new mongoose.Schema(
    {
        slotKey: { type: String, required: true, trim: true },
        runId: { type: mongoose.Schema.Types.ObjectId, required: true },
        quantity: { type: Number, required: true, min: 0 },
        note: { type: String, trim: true, maxlength: 500 },
        enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        enteredAt: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedAt: { type: Date, default: Date.now },
        lastClientMutationId: { type: String, trim: true, maxlength: 80 },
    },
    { _id: true }
);

const HourlyQcEntrySchema = new mongoose.Schema(
    {
        slotKey: { type: String, required: true, trim: true },
        runId: { type: mongoose.Schema.Types.ObjectId, required: true },
        passedQuantity: { type: Number, required: true, min: 0 },
        defectQuantity: { type: Number, required: true, min: 0 },
        totalQuantity: { type: Number, required: true, min: 0 },
        note: { type: String, trim: true, maxlength: 500 },
        enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        enteredAt: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedAt: { type: Date, default: Date.now },
        lastClientMutationId: { type: String, trim: true, maxlength: 80 },
    },
    { _id: true }
);

const ProductionSetupCorrectionSchema = new mongoose.Schema(
    {
        reason: { type: String, required: true, trim: true, maxlength: 500 },
        previousItemCodes: { type: [String], default: [] },
        previousUnitPrices: { type: [Number], default: [] },
        nextItemCode: { type: String, required: true, trim: true },
        nextUnitPrice: { type: Number, required: true, min: 0 },
        nextHourlyQuota: { type: Number, required: true, min: 0 },
        correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        correctedAt: { type: Date, default: Date.now },
    },
    { _id: true }
);

const ProductionLineRecordSchema = new mongoose.Schema(
    {
        dayId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionDay', required: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        productionDate: { type: String, required: true },
        lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine', required: true },
        lineCode: { type: String, required: true, trim: true },
        lineName: { type: String, trim: true },
        leaderName: { type: String, trim: true },
        sortOrder: { type: Number, default: 0 },
        workerCount: { type: Number, min: 0, default: 0 },
        workerCountConfirmedAt: { type: Date },
        workerCountConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        runs: { type: [ProductionRunSchema], default: [] },
        entries: { type: [HourlyProductionEntrySchema], default: [] },
        qcEntries: { type: [HourlyQcEntrySchema], default: [] },
        setupCorrections: { type: [ProductionSetupCorrectionSchema], default: [] },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    {
        timestamps: true,
        optimisticConcurrency: true,
    }
);

ProductionLineRecordSchema.index({ dayId: 1, lineId: 1 }, { unique: true });
ProductionLineRecordSchema.index({ plantId: 1, productionDate: 1, sortOrder: 1 });

const ProductionLineRecord = mongoose.model('ProductionLineRecord', ProductionLineRecordSchema);

export default ProductionLineRecord;
