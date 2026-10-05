import { randomUUID } from 'node:crypto';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import type { Request, Response } from 'express';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import User from '@/models/User';
import customResponse from '@/utils/response';
import { serializeUser } from '@/utils/serializers';

const avatarFolder = (userId: string) => `hai-dang/avatars/${userId}/`;

export const validAvatarSignature = (buffer: Buffer, mimeType: string) => {
    if (mimeType === 'image/jpeg') return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mimeType === 'image/webp')
        return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    return false;
};

const deleteOwnedAvatar = async (userId: string, publicId?: string | null) => {
    if (!publicId?.startsWith(avatarFolder(userId))) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true }),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Avatar cleanup timeout')), 10000);
            }),
        ]);
    } catch {
        // Cleanup failure must not undo an already saved profile.
        console.warn('[Avatar] Could not remove an unused avatar');
    } finally {
        clearTimeout(timer);
    }
};

const uploadAvatar = (file: Express.Multer.File, userId: string): Promise<UploadApiResponse> =>
    new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                public_id: `${avatarFolder(userId)}${randomUUID()}`,
                resource_type: 'image',
                allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
                format: 'webp',
                overwrite: false,
                timeout: 60000,
                transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'center', quality: 'auto' }],
            },
            (error, result) => {
                if (error || !result?.secure_url || !result.public_id) {
                    reject(new Error('Khong tai duoc anh dai dien. Vui long thu lai voi anh JPG, PNG hoac WEBP.'));
                    return;
                }
                resolve(result);
            }
        );
        stream.on('error', () => reject(new Error('Khong tai duoc anh dai dien. Vui long thu lai.')));
        stream.end(file.buffer);
    });

export const updateMyAvatar = async (req: Request, res: Response) => {
    if (!req.file) throw new BadRequestError('Vui long chon anh dai dien');
    if (!validAvatarSignature(req.file.buffer, req.file.mimetype))
        throw new BadRequestError('Tep khong phai anh JPG, PNG hoac WEBP hop le');

    const userId = req.userId!;
    const previous = await User.findOne({ _id: userId, isDeleted: { $ne: true }, isActive: true });
    if (!previous) throw new NotFoundError('Khong tim thay tai khoan');
    const uploaded = await uploadAvatar(req.file, userId);
    let updated;
    try {
        // Do not overwrite another avatar change that completed while this upload was in progress.
        updated = await User.findOneAndUpdate(
            {
                _id: userId,
                isDeleted: { $ne: true },
                isActive: true,
                avatarUrlRef: previous.avatarUrlRef ?? null,
                avatarUrl: previous.avatarUrl ?? null,
            },
            { $set: { avatarUrl: uploaded.secure_url, avatarUrlRef: uploaded.public_id } },
            { returnDocument: 'after', runValidators: true }
        ).populate('plantId');
        if (!updated) throw new DuplicateError('Anh dai dien vua thay doi. Tai lai ho so va thu lai.');
    } catch (error) {
        await deleteOwnedAvatar(userId, uploaded.public_id);
        throw error;
    }
    await deleteOwnedAvatar(userId, previous.avatarUrlRef);
    return res.status(200).json(
        customResponse({
            data: serializeUser(updated),
            message: 'Da cap nhat anh dai dien',
            status: 200,
            success: true,
        })
    );
};

export const removeMyAvatar = async (req: Request, res: Response) => {
    const userId = req.userId!;
    const previous = await User.findOne({ _id: userId, isDeleted: { $ne: true }, isActive: true });
    if (!previous) throw new NotFoundError('Khong tim thay tai khoan');
    const updated = await User.findOneAndUpdate(
        {
            _id: userId,
            isDeleted: { $ne: true },
            isActive: true,
            avatarUrlRef: previous.avatarUrlRef ?? null,
            avatarUrl: previous.avatarUrl ?? null,
        },
        { $set: { avatarUrl: null, avatarUrlRef: null } },
        { returnDocument: 'after', runValidators: true }
    ).populate('plantId');
    if (!updated) throw new DuplicateError('Anh dai dien vua thay doi. Tai lai ho so va thu lai.');
    await deleteOwnedAvatar(userId, previous.avatarUrlRef);
    return res
        .status(200)
        .json(
            customResponse({ data: serializeUser(updated), message: 'Da go anh dai dien', status: 200, success: true })
        );
};
