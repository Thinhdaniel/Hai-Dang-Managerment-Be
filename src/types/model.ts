import { Document, Types } from 'mongoose';

export interface IModel extends Document {
    name: string;
    createdBy?: Types.ObjectId;
    updatedBy?: Types.ObjectId;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
