import mongoose from 'mongoose';

const ProductionQcInspectionSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem', required: true },
        itemCode: { type: String, required: true, trim: true, maxlength: 60 },
        itemName: { type: String, trim: true, maxlength: 200 },
        unit: { type: String, trim: true, maxlength: 30, default: 'SP' },
        orderCode: { type: String, trim: true, uppercase: true, maxlength: 80 },
        inspectionType: {
            type: String,
            enum: ['first_pass', 'recheck'],
            required: true,
            default: 'first_pass',
        },
        sourceType: {
            type: String,
            enum: ['current_day', 'carryover'],
            required: true,
            default: 'current_day',
        },
        sourceProductionDate: {
            type: String,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },
        passedQuantity: { type: Number, required: true, min: 0, max: 100_000_000 },
        defectQuantity: { type: Number, required: true, min: 0, max: 100_000_000 },
        totalQuantity: { type: Number, required: true, min: 0, max: 100_000_000 },
        note: { type: String, trim: true, maxlength: 500 },
    },
    { _id: true }
);

const ProductionQcRecordSchema = new mongoose.Schema(
    {
        dayId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionDay', required: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        productionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        lineId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionLine', required: true },
        lineCode: { type: String, required: true, trim: true, maxlength: 30 },
        lineName: { type: String, trim: true, maxlength: 120 },
        slotKey: { type: String, required: true, trim: true, maxlength: 24 },
        inspections: {
            type: [ProductionQcInspectionSchema],
            required: true,
            validate: {
                validator: (entries: unknown[]) => entries.length > 0 && entries.length <= 30,
                message: 'Mỗi chuyền trong một khung giờ cần từ 1 đến 30 dòng QC',
            },
        },
        enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        enteredAt: { type: Date, required: true, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        lastClientMutationId: { type: String, trim: true, maxlength: 100 },
    },
    {
        timestamps: true,
        optimisticConcurrency: true,
    }
);

ProductionQcRecordSchema.index({ dayId: 1, lineId: 1, slotKey: 1 }, { unique: true });
ProductionQcRecordSchema.index({ plantId: 1, productionDate: 1, lineId: 1 });
ProductionQcRecordSchema.index({ plantId: 1, 'inspections.itemId': 1, productionDate: 1 });

const ProductionQcRecord = mongoose.model('ProductionQcRecord', ProductionQcRecordSchema);

export default ProductionQcRecord;
