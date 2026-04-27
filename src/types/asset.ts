import { Types } from 'mongoose';
import { ASSET_STATUS } from '@/constant/assetStatus';

export interface IAsset {
    name: string;
    machineCode: string;
    publicId?: string;
    serial?: string;
    type: string;
    model: string;
    note?: string;
    status: ASSET_STATUS;
    statusNote?: string;
    brandId: Types.ObjectId;
    plantId: Types.ObjectId;
    area?: string;
    purchaseDate?: Date;
    purchasePrice?: number;
    specifications?: Record<string, string | number>;
    imageUrl?: string;
    lastMaintenanceDate?: Date;
    nextMaintenanceDate?: Date;
    createdBy?: Types.ObjectId;
    updatedBy?: Types.ObjectId;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
