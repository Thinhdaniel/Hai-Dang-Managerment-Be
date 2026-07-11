import mongoose from 'mongoose';
import { nanoid } from 'nanoid';

// Khu vực trên sơ đồ mặt bằng xưởng (Chuyền may 1, Khu cắt...).
// Toạ độ x/y/w/h lưu theo % (0-100) so với sàn để không phụ thuộc kích thước màn hình.
const FloorZoneSchema = new mongoose.Schema(
    {
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        anchorCode: {
            type: String,
            required: true,
            unique: true,
            sparse: true,
            trim: true,
            uppercase: true,
            default: () => `ZN-${nanoid(10).toUpperCase()}`,
        },
        x: { type: Number, required: true, min: 0, max: 100 },
        y: { type: Number, required: true, min: 0, max: 100 },
        w: { type: Number, required: true, min: 1, max: 100 },
        h: { type: Number, required: true, min: 1, max: 100 },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

FloorZoneSchema.index({ plantId: 1, anchorCode: 1 });

const FloorZone = mongoose.model('FloorZone', FloorZoneSchema);

export default FloorZone;
