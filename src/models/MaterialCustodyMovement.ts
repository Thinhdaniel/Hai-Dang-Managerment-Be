import mongoose from 'mongoose';
import { MATERIAL_CUSTODY_MOVEMENT_TYPE, MATERIAL_CUSTODY_RESOLUTION_VALUES } from '@/constant/materialCustody';

const MaterialCustodyMovementSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCustodyAssignment', required: true },
        campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialUsageCampaign', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialRecipient' },
        type: { type: String, enum: Object.values(MATERIAL_CUSTODY_MOVEMENT_TYPE), required: true },
        resolution: { type: String, enum: MATERIAL_CUSTODY_RESOLUTION_VALUES },
        quantity: { type: Number, required: true, min: 0.000001 },
        note: { type: String, trim: true, maxlength: 1000 },
        evidenceUrls: { type: [String], default: [] },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        occurredAt: { type: Date, required: true, default: Date.now },
        reversalOfId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCustodyMovement' },
    },
    { timestamps: true, versionKey: false }
);

MaterialCustodyMovementSchema.index({ assignmentId: 1, occurredAt: -1 });
MaterialCustodyMovementSchema.index({ plantId: 1, occurredAt: -1 });
MaterialCustodyMovementSchema.index({ campaignId: 1, occurredAt: -1 });

export default mongoose.model('MaterialCustodyMovement', MaterialCustodyMovementSchema);
