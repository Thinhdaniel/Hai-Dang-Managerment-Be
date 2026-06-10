import mongoose from 'mongoose';
import { QR_LABEL_STATUS, QR_LABEL_TYPE } from '@/constant/qrLabel';

const QrLabelSchema = new mongoose.Schema(
    {
        publicId: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
        },
        type: {
            type: String,
            enum: Object.values(QR_LABEL_TYPE),
            default: QR_LABEL_TYPE.MACHINE,
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(QR_LABEL_STATUS),
            default: QR_LABEL_STATUS.UNUSED,
            required: true,
        },
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
        },
        batchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QrLabelBatch',
        },
        plannedPlantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        plannedArea: {
            type: String,
            trim: true,
        },
        note: {
            type: String,
            trim: true,
        },
        printedAt: {
            type: Date,
        },
        printedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        activatedAt: {
            type: Date,
        },
        activatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        retiredAt: {
            type: Date,
        },
        retiredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        retiredReason: {
            type: String,
            trim: true,
        },
        scanCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        lastScannedAt: {
            type: Date,
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

QrLabelSchema.index({ type: 1, status: 1 });
QrLabelSchema.index({ batchId: 1 });
QrLabelSchema.index({ assetId: 1 });
QrLabelSchema.index({ plannedPlantId: 1 });
QrLabelSchema.index({ createdAt: -1 });

const QrLabel = mongoose.model('QrLabel', QrLabelSchema);

export default QrLabel;
