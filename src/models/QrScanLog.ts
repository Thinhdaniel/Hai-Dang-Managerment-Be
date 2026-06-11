import mongoose from 'mongoose';

const QrScanLogSchema = new mongoose.Schema(
    {
        rawValue: {
            type: String,
            trim: true,
        },
        publicId: {
            type: String,
            trim: true,
            uppercase: true,
        },
        labelId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'QrLabel',
        },
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
        },
        action: {
            type: String,
            enum: [
                'open_profile',
                'quick_update',
                'stocktake',
                'transfer_scan',
                'maintenance_quick_create',
                'maintenance_quick_create_success',
                'borrowing_receive',
                'borrowing_receive_success',
                'borrowing_return',
                'borrowing_return_success',
            ],
            required: true,
        },
        result: {
            type: String,
            enum: [
                'resolved',
                'not_found',
                'ambiguous',
                'duplicate',
                'present',
                'wrong_area',
                'wrong_plant',
                'success',
                'failed',
            ],
            required: true,
        },
        source: {
            type: String,
            enum: ['camera', 'manual', 'qr_label', 'legacy_asset', 'search', 'unknown'],
            default: 'unknown',
        },
        actorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        actorRole: {
            type: String,
            trim: true,
        },
        ip: {
            type: String,
            trim: true,
        },
        userAgent: {
            type: String,
            trim: true,
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

QrScanLogSchema.index({ assetId: 1, createdAt: -1 });
QrScanLogSchema.index({ publicId: 1, createdAt: -1 });
QrScanLogSchema.index({ action: 1, createdAt: -1 });
QrScanLogSchema.index({ result: 1, createdAt: -1 });
QrScanLogSchema.index({ actorId: 1, createdAt: -1 });
QrScanLogSchema.index({ createdAt: -1 });

const QrScanLog = mongoose.model('QrScanLog', QrScanLogSchema);

export default QrScanLog;
