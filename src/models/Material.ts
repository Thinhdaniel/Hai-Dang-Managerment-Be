import mongoose from 'mongoose';
import { MATERIAL_COST_TYPE_VALUES } from '@/constant/materialCostType';
import { MATERIAL_REUSE_TRACKING_MODE, MATERIAL_REUSE_TRACKING_MODE_VALUES } from '@/constant/materialCustody';

const MaterialSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        code: {
            type: String,
            trim: true,
        },
        category: {
            type: String,
            trim: true,
        },
        // Phân loại bản chất chi phí (consumable/spare_part/tool/asset). Rỗng = chưa phân loại.
        costType: {
            type: String,
            enum: MATERIAL_COST_TYPE_VALUES,
        },
        reuseTrackingMode: {
            type: String,
            enum: MATERIAL_REUSE_TRACKING_MODE_VALUES,
            default: MATERIAL_REUSE_TRACKING_MODE.NONE,
        },
        defaultReturnDays: {
            type: Number,
            min: 0,
            max: 3650,
            default: 0,
        },
        conditionCheckRequired: {
            type: Boolean,
            default: false,
        },
        unit: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        minStockLevel: {
            type: Number,
            default: 0,
            min: 0,
        },
        trackInventory: {
            type: Boolean,
            default: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
        deletedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

MaterialSchema.index(
    { code: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            code: { $exists: true, $type: 'string' },
        },
    }
);
MaterialSchema.index({ name: 1 });
MaterialSchema.index({ category: 1 });
MaterialSchema.index({ isActive: 1 });

const Material = mongoose.model('Material', MaterialSchema);

export default Material;
