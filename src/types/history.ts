import { Document, Types } from 'mongoose';

type TTransferStatus = 'pending' | 'deliverd';
export interface ITransferHistory extends Document {
    assetId: Types.ObjectId;
    fromPlantId: Types.ObjectId;
    fromPlant?: string;
    toPlantId: Types.ObjectId;
    toPlant?: string;
    note?: string;
    status: TTransferStatus;
    createdBy?: Types.ObjectId;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
}

export interface IMaintenanceHistory extends Document {
    assetId: Types.ObjectId;
    note?: string;
    createdBy?: Types.ObjectId;
    updatedBy?: Types.ObjectId;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
