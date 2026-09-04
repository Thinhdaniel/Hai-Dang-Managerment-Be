import mongoose from 'mongoose';
import { MATERIAL_CUSTODY_CAMPAIGN_STATUS } from '@/constant/materialCustody';

const MaterialUsageCampaignSchema = new mongoose.Schema(
    {
        campaignCode: { type: String, required: true, trim: true, uppercase: true },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        productionItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionItem' },
        itemCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 80 },
        itemName: { type: String, trim: true, maxlength: 200 },
        orderCode: { type: String, trim: true, uppercase: true, maxlength: 80 },
        status: {
            type: String,
            enum: Object.values(MATERIAL_CUSTODY_CAMPAIGN_STATUS),
            default: MATERIAL_CUSTODY_CAMPAIGN_STATUS.ACTIVE,
        },
        startedAt: { type: Date, required: true, default: Date.now },
        recallOpenedAt: { type: Date },
        dueAt: { type: Date },
        closedAt: { type: Date },
        note: { type: String, trim: true, maxlength: 1000 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        recallOpenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

MaterialUsageCampaignSchema.index({ campaignCode: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
MaterialUsageCampaignSchema.index({ plantId: 1, status: 1, startedAt: -1 });
MaterialUsageCampaignSchema.index({ plantId: 1, itemCode: 1, orderCode: 1 });

export default mongoose.model('MaterialUsageCampaign', MaterialUsageCampaignSchema);
