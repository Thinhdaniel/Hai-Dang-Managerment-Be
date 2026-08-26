import cloudinaryConfig from '@/config/cloudinary.config';
import { BadRequestError } from '@/errors/customError';
import SystemSetting from '@/models/SystemSetting';
import customResponse from '@/utils/response';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import streamifier from 'streamifier';

cloudinary.config(cloudinaryConfig);

const NOTIFICATION_SOUND_KEY = 'notification_sound';

type NotificationSoundValue = {
    url: string;
    publicId: string;
    name: string;
    size: number;
};

// Cloudinary lưu file âm thanh dưới resource_type 'video'
const uploadSoundFile = (file: Express.Multer.File): Promise<UploadApiResponse> =>
    new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: 'hai-dang/system',
                resource_type: 'video',
                tags: ['system', 'notification-sound'],
            },
            (error, result?: UploadApiResponse) => {
                if (error || !result) {
                    reject(error || new Error('Upload file am thanh that bai'));
                    return;
                }
                resolve(result);
            }
        );

        streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });

const destroySoundFile = async (publicId?: string) => {
    if (!publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
    } catch (error) {
        console.error('[SystemSetting] Failed to delete old notification sound:', error);
    }
};

const serializeSound = (setting: { value?: any; updatedAt?: Date } | null) => {
    const value = setting?.value as NotificationSoundValue | undefined;
    if (!value?.url) return null;

    return {
        url: value.url,
        name: value.name,
        updatedAt: setting?.updatedAt,
    };
};

// Mọi người dùng đã đăng nhập đều đọc được — FE cần URL để phát chuông
export const getNotificationSound = async (req: Request, res: Response, _next: NextFunction) => {
    const setting = await SystemSetting.findOne({ key: NOTIFICATION_SOUND_KEY }).lean();

    res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeSound(setting),
            success: true,
            message: 'Lay chuong thong bao he thong thanh cong',
            status: StatusCodes.OK,
        })
    );
};

export const uploadNotificationSound = async (req: Request, res: Response, _next: NextFunction) => {
    const file = req.file;
    if (!file) {
        throw new BadRequestError('Chua chon file am thanh MP3');
    }

    const existing = await SystemSetting.findOne({ key: NOTIFICATION_SOUND_KEY });
    const oldPublicId = (existing?.value as NotificationSoundValue | undefined)?.publicId;

    const uploaded = await uploadSoundFile(file);

    const value: NotificationSoundValue = {
        url: uploaded.secure_url,
        publicId: uploaded.public_id,
        name: file.originalname,
        size: file.size,
    };

    const setting = await SystemSetting.findOneAndUpdate(
        { key: NOTIFICATION_SOUND_KEY },
        {
            $set: {
                value,
                updatedBy:
                    req.userId && mongoose.Types.ObjectId.isValid(req.userId)
                        ? new mongoose.Types.ObjectId(req.userId)
                        : undefined,
            },
        },
        { returnDocument: 'after', upsert: true }
    );

    // Xoá file cũ sau khi đã ghi setting mới thành công
    await destroySoundFile(oldPublicId);

    res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeSound(setting),
            success: true,
            message: 'Cap nhat chuong thong bao he thong thanh cong',
            status: StatusCodes.OK,
        })
    );
};

export const deleteNotificationSound = async (req: Request, res: Response, _next: NextFunction) => {
    const setting = await SystemSetting.findOneAndDelete({ key: NOTIFICATION_SOUND_KEY });
    await destroySoundFile((setting?.value as NotificationSoundValue | undefined)?.publicId);

    res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            success: true,
            message: 'Da go chuong thong bao he thong',
            status: StatusCodes.OK,
        })
    );
};
