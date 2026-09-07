import mongoose from 'mongoose';

const schema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCustodyAssignment' },
        type: {
            type: String,
            enum: ['return', 'reissue', 'repair_complete', 'mark_damaged', 'dispose'],
            required: true,
        },
        fromBucket: { type: String, enum: ['available', 'repair', 'damaged'] },
        toBucket: { type: String, enum: ['available', 'repair', 'damaged'] },
        quantity: { type: Number, min: 0.000001, required: true },
        referenceValue: { type: Number, min: 0 },
        confirmedReferenceUnitPrice: { type: Number, min: 0 },
        note: { type: String, maxlength: 1000 },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        occurredAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);
schema.index({ plantId: 1, materialId: 1, occurredAt: -1 });
export default mongoose.model('ReusableMaterialMovement', schema);
