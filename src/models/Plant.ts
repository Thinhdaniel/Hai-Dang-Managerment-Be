import mongoose from 'mongoose';

const PlantSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        normalizedName: {
            type: String,
            required: true,
            trim: true,
            select: false,
        },
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        address: {
            type: String,
            trim: true,
        },
        phone: {
            type: String,
            trim: true,
        },
        // Toạ độ cơ sở -> dùng để suy ra "máy đang gần cơ sở nào nhất" từ GPS lúc quét QR
        coordinates: {
            lat: { type: Number, min: -90, max: 90 },
            lng: { type: Number, min: -180, max: 180 },
        },
        managerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        productionAccess: {
            type: new mongoose.Schema(
                {
                    enabled: {
                        type: Boolean,
                        default: false,
                    },
                    enabledAt: Date,
                    enabledBy: {
                        type: mongoose.Schema.Types.ObjectId,
                        ref: 'User',
                    },
                    disabledAt: Date,
                    disabledBy: {
                        type: mongoose.Schema.Types.ObjectId,
                        ref: 'User',
                    },
                    stage: {
                        type: String,
                        enum: ['disabled', 'preparing', 'pilot', 'live', 'paused'],
                        default: 'disabled',
                    },
                    previousStage: {
                        type: String,
                        enum: ['preparing', 'pilot', 'live'],
                    },
                    revision: { type: Number, min: 0, default: 0 },
                    wave: { type: Number, min: 1, max: 100 },
                    plannedGoLiveDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
                    ownerName: { type: String, trim: true, maxlength: 160 },
                    acceptedPilotRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductionPilotRun' },
                    acceptedPilotCode: { type: String, trim: true, maxlength: 80 },
                    lastTransitionAt: Date,
                    lastTransitionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
                    lastTransitionByName: { type: String, trim: true, maxlength: 160 },
                    lastTransitionReason: { type: String, trim: true, maxlength: 500 },
                    history: {
                        type: [
                            new mongoose.Schema(
                                {
                                    fromStage: { type: String, required: true },
                                    toStage: { type: String, required: true },
                                    reason: { type: String, required: true, trim: true, maxlength: 500 },
                                    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
                                    actorName: { type: String, required: true, trim: true, maxlength: 160 },
                                    at: { type: Date, default: Date.now, required: true },
                                },
                                { _id: true }
                            ),
                        ],
                        default: [],
                    },
                },
                { _id: false }
            ),
            default: () => ({ enabled: false, stage: 'disabled', revision: 0 }),
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

PlantSchema.index(
    { normalizedName: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            normalizedName: { $exists: true },
        },
    }
);

const Plant = mongoose.model('Plant', PlantSchema);

export default Plant;
