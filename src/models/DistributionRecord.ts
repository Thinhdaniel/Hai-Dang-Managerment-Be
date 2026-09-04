import mongoose from 'mongoose';
import { MATERIAL_CUSTODY_HOLDER_TYPE, MATERIAL_REUSE_TRACKING_MODE } from '@/constant/materialCustody';

const DistributionRecordItemSchema = new mongoose.Schema(
    {
        materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        materialName: { type: String, trim: true },
        unit: { type: String, trim: true },
        quantity: { type: Number, required: true, min: 0 }, // backward compat
        quantityRequested: { type: Number, min: 0 },
        quantityDistributed: { type: Number, min: 0 },
        quantityShortage: { type: Number, min: 0, default: 0 },
        sourceRequestItemIndex: { type: Number, min: 0 },
        sourceShortageId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplyShortage' },
        fulfillmentStatus: {
            type: String,
            enum: ['fulfilled', 'partial', 'not_supplied'],
            default: 'fulfilled',
        },
        unitPrice: { type: Number, min: 0 },
        vatRate: { type: Number, min: 0, default: 0 },
        vatAmount: { type: Number, min: 0 },
        totalPrice: { type: Number, min: 0 },
        totalWithVat: { type: Number, min: 0 },
        catalogStatus: {
            type: String,
            enum: ['matched', 'unmatched', 'ignored'],
            default: 'matched',
        },
        quantityInventoried: { type: Number, min: 0, default: 0 },
        inventoryStatus: {
            type: String,
            enum: ['pending', 'applied', 'skipped'],
            default: 'pending',
        },
        inventorySkipReason: { type: String, trim: true },
        distributedDate: { type: Date },
        adjustReason: { type: String, trim: true },
        note: { type: String, trim: true },
        reuseTrackingMode: {
            type: String,
            enum: Object.values(MATERIAL_REUSE_TRACKING_MODE),
            default: MATERIAL_REUSE_TRACKING_MODE.NONE,
        },
        custodyAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialCustodyAssignment' },
    },
    { _id: false }
);

const DistributionRecordSchema = new mongoose.Schema(
    {
        distributionCode: {
            type: String,
            trim: true,
        },
        distributionType: {
            type: String,
            enum: ['facility_transfer', 'internal_issue'],
            default: 'facility_transfer',
        },
        fromPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        toPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        purchaseOrderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PurchaseOrder',
        },
        /** Phiếu đề xuất cấp vật tư đã dẫn đến phiếu cấp phát này */
        supplyRequestId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'PurchaseRequest',
        },
        isCompensation: {
            type: Boolean,
            default: false,
        },
        compensationForShortageIds: {
            type: [mongoose.Schema.Types.ObjectId],
            ref: 'SupplyShortage',
            default: [],
        },
        items: {
            type: [DistributionRecordItemSchema],
            default: [],
        },
        status: {
            type: String,
            enum: ['draft', 'pending', 'processing', 'distributed', 'confirmed'],
            default: 'pending',
        },
        distributedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        distributedAt: {
            type: Date,
        },
        confirmedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        confirmedAt: {
            type: Date,
        },
        requesterName: { type: String, trim: true },
        holderType: { type: String, enum: Object.values(MATERIAL_CUSTODY_HOLDER_TYPE) },
        recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialRecipient' },
        holderCode: { type: String, trim: true },
        holderName: { type: String, trim: true },
        usageCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'MaterialUsageCampaign' },
        expectedReturnAt: { type: Date },
        targetDepartment: { type: String, trim: true },
        targetLine: { type: String, trim: true },
        note: { type: String, trim: true },
        totalAmount: { type: Number, min: 0 },
        totalVatAmount: { type: Number, min: 0 },
        totalWithVat: { type: Number, min: 0 },
        isDeleted: { type: Boolean, default: false },
        deletedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

DistributionRecordSchema.index(
    { distributionCode: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            distributionCode: { $exists: true, $type: 'string' },
        },
    }
);
DistributionRecordSchema.index({ fromPlantId: 1, status: 1 });
DistributionRecordSchema.index({ toPlantId: 1, status: 1 });
DistributionRecordSchema.index({ purchaseOrderId: 1 });
DistributionRecordSchema.index({ createdAt: -1 });

const DistributionRecord = mongoose.model('DistributionRecord', DistributionRecordSchema);

export default DistributionRecord;
