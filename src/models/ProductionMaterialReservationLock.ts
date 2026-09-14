import mongoose from 'mongoose';

const ProductionMaterialReservationLockSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        revision: { type: Number, min: 0, default: 0 },
    },
    { timestamps: true, versionKey: false }
);

ProductionMaterialReservationLockSchema.index({ plantId: 1, materialId: 1 }, { unique: true });

export default mongoose.model('ProductionMaterialReservationLock', ProductionMaterialReservationLockSchema);
