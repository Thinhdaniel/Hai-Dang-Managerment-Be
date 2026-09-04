import mongoose from 'mongoose';
import {
    MATERIAL_CUSTODY_ASSIGNMENT_STATUS,
    MATERIAL_CUSTODY_HOLDER_TYPE,
    MATERIAL_CUSTODY_SOURCE_TYPE,
    MATERIAL_REUSE_TRACKING_MODE,
} from '@/constant/materialCustody';

const MaterialCustodyAssignmentSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
        materialCode: { type: String, trim: true },
        materialName: { type: String, required: true, trim: true },
        unit: { type: String, required: true, trim: true },
        trackingMode: {
            type: String,
            enum: [MATERIAL_REUSE_TRACKING_MODE.QUANTITY, MATERIAL_REUSE_TRACKING_MODE.SERIALIZED],
            required: true,
        },
        holderType: { type: String, enum: Object.values(MATERIAL_CUSTODY_HOLDER_TYPE), required: true },
        recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialRecipient' },
        holderCode: { type: String, trim: true },
        holderName: { type: String, required: true, trim: true },
        department: { type: String, trim: true },
        lineName: { type: String, trim: true },
        campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialUsageCampaign', required: true },
        productionItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem' },
        itemCode: { type: String, required: true, trim: true },
        itemName: { type: String, trim: true },
        orderCode: { type: String, trim: true },
        sourceType: { type: String, enum: Object.values(MATERIAL_CUSTODY_SOURCE_TYPE), required: true },
        sourceDistributionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DistributionRecord' },
        sourceDistributionItemIndex: { type: Number, min: 0 },
        sourceAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCustodyAssignment' },
        quantityIssued: { type: Number, required: true, min: 0.000001 },
        quantityReturnedUsable: { type: Number, min: 0, default: 0 },
        quantityReturnedRepair: { type: Number, min: 0, default: 0 },
        quantityReturnedDamaged: { type: Number, min: 0, default: 0 },
        quantityLost: { type: Number, min: 0, default: 0 },
        quantityTransferred: { type: Number, min: 0, default: 0 },
        unitPrice: { type: Number, min: 0, default: 0 },
        status: {
            type: String,
            enum: Object.values(MATERIAL_CUSTODY_ASSIGNMENT_STATUS),
            default: MATERIAL_CUSTODY_ASSIGNMENT_STATUS.ACTIVE,
        },
        issuedAt: { type: Date, required: true, default: Date.now },
        dueAt: { type: Date },
        resolvedAt: { type: Date },
        note: { type: String, trim: true, maxlength: 1000 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

MaterialCustodyAssignmentSchema.index({ plantId: 1, status: 1, dueAt: 1 });
MaterialCustodyAssignmentSchema.index({ recipientId: 1, status: 1 });
MaterialCustodyAssignmentSchema.index({ campaignId: 1, status: 1 });
MaterialCustodyAssignmentSchema.index({ materialId: 1, status: 1 });
MaterialCustodyAssignmentSchema.index(
    { sourceDistributionId: 1, sourceDistributionItemIndex: 1 },
    {
        unique: true,
        partialFilterExpression: {
            sourceDistributionId: { $exists: true },
            sourceDistributionItemIndex: { $exists: true },
            isDeleted: false,
        },
    }
);

export default mongoose.model('MaterialCustodyAssignment', MaterialCustodyAssignmentSchema);
