import mongoose from 'mongoose';

const ReusableMaterialStockSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        availableQuantity: { type: Number, min: 0, default: 0 },
        repairQuantity: { type: Number, min: 0, default: 0 },
        damagedQuantity: { type: Number, min: 0, default: 0 },
        lastMovementAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

ReusableMaterialStockSchema.index({ plantId: 1, materialId: 1 }, { unique: true });
ReusableMaterialStockSchema.index({ plantId: 1, availableQuantity: -1 });

export default mongoose.model('ReusableMaterialStock', ReusableMaterialStockSchema);
