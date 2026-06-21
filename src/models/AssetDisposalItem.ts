import mongoose from 'mongoose';
import {
    ASSET_DISPOSAL_ACTION,
    ASSET_DISPOSAL_CONDITION,
    ASSET_DISPOSAL_ITEM_STATUS,
    ASSET_DISPOSAL_SOURCE_TYPE,
} from '@/constant/assetDisposal';

const AssetDisposalItemSchema = new mongoose.Schema(
    {
        batchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AssetDisposalBatch',
            required: true,
        },
        sourceType: {
            type: String,
            enum: Object.values(ASSET_DISPOSAL_SOURCE_TYPE),
            default: ASSET_DISPOSAL_SOURCE_TYPE.ASSET,
            required: true,
        },
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
        },
        qrLabelId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QrLabel',
        },
        publicId: {
            type: String,
            trim: true,
            uppercase: true,
        },
        machineCode: {
            type: String,
            trim: true,
        },
        name: {
            type: String,
            trim: true,
        },
        type: {
            type: String,
            trim: true,
        },
        model: {
            type: String,
            trim: true,
        },
        serial: {
            type: String,
            trim: true,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        area: {
            type: String,
            trim: true,
        },
        condition: {
            type: String,
            enum: Object.values(ASSET_DISPOSAL_CONDITION),
            default: ASSET_DISPOSAL_CONDITION.UNKNOWN,
        },
        reason: {
            type: String,
            trim: true,
        },
        suggestedAction: {
            type: String,
            enum: Object.values(ASSET_DISPOSAL_ACTION),
            default: ASSET_DISPOSAL_ACTION.UNKNOWN,
        },
        estimatedValue: {
            type: Number,
            min: 0,
        },
        finalValue: {
            type: Number,
            min: 0,
        },
        photos: {
            type: [String],
            default: [],
        },
        status: {
            type: String,
            enum: Object.values(ASSET_DISPOSAL_ITEM_STATUS),
            default: ASSET_DISPOSAL_ITEM_STATUS.PENDING,
            required: true,
        },
        previousAssetStatus: {
            type: String,
            trim: true,
        },
        checkedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        checkedAt: {
            type: Date,
        },
        disposedAt: {
            type: Date,
        },
        note: {
            type: String,
            trim: true,
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

AssetDisposalItemSchema.index({ batchId: 1 });
AssetDisposalItemSchema.index({ assetId: 1 });
AssetDisposalItemSchema.index({ qrLabelId: 1 });
AssetDisposalItemSchema.index({ publicId: 1 });
AssetDisposalItemSchema.index({ status: 1 });

const AssetDisposalItem = mongoose.model('AssetDisposalItem', AssetDisposalItemSchema);

export default AssetDisposalItem;
