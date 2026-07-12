import mongoose from 'mongoose';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';

const AssetSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        machineCode: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        publicId: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            uppercase: true,
        },
        serial: {
            type: String,
            trim: true,
        },
        type: {
            type: String,
            required: true,
            trim: true,
        },
        model: {
            type: String,
            required: true,
            trim: true,
            default: function (this: { type?: string }) {
                return this.type;
            },
        },
        note: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: Object.values(ASSET_STATUS),
            default: ASSET_STATUS.ACTIVE,
        },
        statusNote: {
            type: String,
            trim: true,
        },
        ownershipType: {
            type: String,
            enum: Object.values(ASSET_OWNERSHIP_TYPE),
            default: ASSET_OWNERSHIP_TYPE.OWNED,
        },
        brandId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Brand',
            required: true,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
        },
        area: {
            type: String,
            trim: true,
        },
        purchaseDate: {
            type: Date,
        },
        purchasePrice: {
            type: Number,
            min: 0,
        },
        specifications: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        imageUrl: {
            type: String,
            trim: true,
        },
        // Ảnh xác thực máy — chụp khi thêm máy, dùng truy xuất khi mất tem QR
        // (đặc biệt máy không có serial/model mờ). Tối đa 3 ảnh.
        verificationImages: {
            type: [String],
            default: undefined,
        },
        lastMaintenanceDate: {
            type: Date,
        },
        nextMaintenanceDate: {
            type: Date,
        },
        // Vị trí thực tế gần nhất suy ra từ GPS lúc quét QR (tách bạch với plantId - cơ sở quản lý chính thức)
        lastSeen: {
            plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant' },
            lat: { type: Number },
            lng: { type: Number },
            accuracy: { type: Number }, // sai số GPS (m) do thiết bị báo
            distanceM: { type: Number }, // khoảng cách tới cơ sở gần nhất (m)
            scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            scannedAt: { type: Date },
        },
        // Vị trí trên sơ đồ mặt bằng xưởng (%, 0-100 so với sàn của cơ sở). Không có = chưa xếp lên sơ đồ.
        floorPos: {
            x: { type: Number, min: 0, max: 100 },
            y: { type: Number, min: 0, max: 100 },
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

AssetSchema.index({ brandId: 1 });
AssetSchema.index({ plantId: 1 });
AssetSchema.index({ status: 1 });
AssetSchema.index({ ownershipType: 1 });
AssetSchema.index({ model: 1 });
AssetSchema.index({ serial: 1 }, { sparse: true });

const Asset = mongoose.model('Asset', AssetSchema);

export default Asset;
