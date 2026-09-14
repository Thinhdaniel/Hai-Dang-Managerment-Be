import mongoose from 'mongoose';

const ProductionMaterialReservationSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        productionOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionOrder', required: true },
        productionOrderCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
        bomId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionBom', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        materialName: { type: String, required: true, trim: true, maxlength: 240 },
        unit: { type: String, required: true, trim: true, maxlength: 40 },
        quantity: { type: Number, required: true, min: 0 },
        status: { type: String, enum: ['active', 'released'], default: 'active' },
        releasedAt: { type: Date },
        releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        releaseReason: { type: String, trim: true, maxlength: 500 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true, optimisticConcurrency: true }
);

ProductionMaterialReservationSchema.index(
    { productionOrderId: 1, materialId: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } }
);
ProductionMaterialReservationSchema.index({ plantId: 1, materialId: 1, status: 1 });
ProductionMaterialReservationSchema.index({ productionOrderId: 1, status: 1 });

export default mongoose.model('ProductionMaterialReservation', ProductionMaterialReservationSchema);
