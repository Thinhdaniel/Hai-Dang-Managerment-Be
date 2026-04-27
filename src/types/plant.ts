import { Document, Types } from 'mongoose';

export interface IPlant extends Document {
    name: string;
    location?: string;
    createdBy?: Types.ObjectId;
    updatedBy?: Types.ObjectId;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
