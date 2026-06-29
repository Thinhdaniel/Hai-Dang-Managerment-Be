import mongoose from 'mongoose';

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
