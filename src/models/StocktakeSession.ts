import mongoose from 'mongoose';

const StocktakeCoverageZoneSchema = new mongoose.Schema(
    {
        zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'FloorZone' },
        name: { type: String, required: true, trim: true },
        anchorCode: { type: String, trim: true, uppercase: true },
        x: { type: Number, min: 0, max: 100 },
        y: { type: Number, min: 0, max: 100 },
        w: { type: Number, min: 1, max: 100 },
        h: { type: Number, min: 1, max: 100 },
        status: {
            type: String,
            enum: ['pending', 'in_progress', 'completed', 'skipped'],
            default: 'pending',
        },
        activationSource: {
            type: String,
            enum: ['anchor', 'manual', 'auto'],
        },
        expectedCount: { type: Number, default: 0, min: 0 },
        scannedCount: { type: Number, default: 0, min: 0 },
        startedAt: { type: Date },
        completedAt: { type: Date },
    },
    { _id: false }
);

const StocktakePositionProposalSchema = new mongoose.Schema(
    {
        assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true },
        machineCode: { type: String, trim: true },
        name: { type: String, trim: true },
        zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'FloorZone', required: true },
        zoneName: { type: String, required: true, trim: true },
        currentX: { type: Number, min: 0, max: 100 },
        currentY: { type: Number, min: 0, max: 100 },
        proposedX: { type: Number, required: true, min: 0, max: 100 },
        proposedY: { type: Number, required: true, min: 0, max: 100 },
        assetUpdatedAt: { type: Date, required: true },
        scannedAt: { type: Date, required: true },
        confidence: { type: Number, required: true, min: 0, max: 1 },
        basis: { type: String, enum: ['scan_order'], default: 'scan_order' },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected', 'conflict'],
            default: 'pending',
        },
        conflictReason: { type: String, trim: true },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: { type: Date },
        reviewNote: { type: String, trim: true },
    },
    { _id: false }
);

const StocktakeItemSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['missing', 'present', 'wrong_area', 'wrong_plant', 'unknown'],
            required: true,
        },
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
        },
        rawValue: {
            type: String,
            trim: true,
        },
        machineCode: {
            type: String,
            trim: true,
        },
        name: {
            type: String,
            trim: true,
        },
        plantName: {
            type: String,
            trim: true,
        },
        area: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            trim: true,
        },
        message: {
            type: String,
            trim: true,
        },
        gpsNote: {
            type: String,
            trim: true,
        },
        scannedAt: {
            type: Date,
        },
        coverageZoneId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FloorZone',
        },
        coverageZoneName: {
            type: String,
            trim: true,
        },
    },
    { _id: false }
);

const StocktakeSessionSchema = new mongoose.Schema(
    {
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        plantName: {
            type: String,
            trim: true,
        },
        area: {
            type: String,
            trim: true,
        },
        areaLabel: {
            type: String,
            trim: true,
        },
        captureMode: {
            type: String,
            enum: ['single', 'sweep'],
            default: 'single',
        },
        scannerEngine: {
            type: String,
            enum: ['zxing', 'barcode_detector'],
        },
        detectedCodeCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        duplicateScanCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        coveragePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },
        coverageCompletedCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        coverageZones: {
            type: [StocktakeCoverageZoneSchema],
            default: [],
        },
        positionProposals: {
            type: [StocktakePositionProposalSchema],
            default: [],
        },
        startedAt: {
            type: Date,
            required: true,
        },
        finishedAt: {
            type: Date,
            required: true,
        },
        expectedCount: {
            type: Number,
            default: 0,
        },
        scannedCount: {
            type: Number,
            default: 0,
        },
        presentCount: {
            type: Number,
            default: 0,
        },
        missingCount: {
            type: Number,
            default: 0,
        },
        anomalyCount: {
            type: Number,
            default: 0,
        },
        items: {
            type: [StocktakeItemSchema],
            default: [],
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

StocktakeSessionSchema.index({ plantId: 1, createdAt: -1 });
StocktakeSessionSchema.index({ createdBy: 1, createdAt: -1 });
StocktakeSessionSchema.index({ createdAt: -1 });

const StocktakeSession = mongoose.model('StocktakeSession', StocktakeSessionSchema);

export default StocktakeSession;
