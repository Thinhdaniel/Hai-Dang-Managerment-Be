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
