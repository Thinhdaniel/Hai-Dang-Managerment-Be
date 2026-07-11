import mongoose from 'mongoose';

const RealityZoneSnapshotSchema = new mongoose.Schema(
    {
        zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'FloorZone', required: true },
        zoneName: { type: String, required: true, trim: true },
        total: { type: Number, default: 0, min: 0 },
        score: { type: Number, default: 0, min: 0, max: 100 },
        counts: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { _id: false }
);

const RealityHealthSnapshotSchema = new mongoose.Schema(
    {
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        snapshotKey: { type: String, required: true, trim: true },
        generatedAt: { type: Date, required: true, default: Date.now },
        score: { type: Number, required: true, min: 0, max: 100 },
        total: { type: Number, default: 0, min: 0 },
        counts: { type: mongoose.Schema.Types.Mixed, default: {} },
        zones: { type: [RealityZoneSnapshotSchema], default: [] },
        latestSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'StocktakeSession' },
    },
    { timestamps: true, versionKey: false }
);

RealityHealthSnapshotSchema.index({ plantId: 1, snapshotKey: 1 }, { unique: true });
RealityHealthSnapshotSchema.index({ plantId: 1, generatedAt: -1 });

export default mongoose.model('RealityHealthSnapshot', RealityHealthSnapshotSchema);
