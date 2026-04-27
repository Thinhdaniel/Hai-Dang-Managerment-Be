import mongoose from 'mongoose';
import { IStorage } from '@/types/storage';

const StorageSchema = new mongoose.Schema(
    {
        quantity: {
            type: Number,
            required: true,
            default: 0,
        },
        modelId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Model',
            required: true,
            unique: true,
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

StorageSchema.index({ modelId: 1 });

const Storage = mongoose.model<IStorage>('Storage', StorageSchema);

export default Storage;
