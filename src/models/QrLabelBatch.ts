import mongoose from 'mongoose';
import { QR_LABEL_BATCH_STATUS, QR_LABEL_TYPE } from '@/constant/qrLabel';

const QrLabelBatchSchema = new mongoose.Schema(
    {
        code: {
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
        quantity: {
            type: Number,
            required: true,
            min: 1,
        },
        status: {
            type: String,
            enum: Object.values(QR_LABEL_BATCH_STATUS),
            default: QR_LABEL_BATCH_STATUS.DRAFT,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        area: {
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

QrLabelBatchSchema.index({ type: 1, status: 1 });
QrLabelBatchSchema.index({ plantId: 1 });
QrLabelBatchSchema.index({ createdAt: -1 });

const QrLabelBatch = mongoose.model('QrLabelBatch', QrLabelBatchSchema);

export default QrLabelBatch;
