import { Document, Types } from 'mongoose';

export interface IStorage extends Document {
    quantity: number;
    modelId: Types.ObjectId;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
