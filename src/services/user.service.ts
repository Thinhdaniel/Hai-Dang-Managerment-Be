import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import Plant from '@/models/Plant';
import User from '@/models/User';
import { revokeUserSessions } from '@/services/token.service';
import customResponse from '@/utils/response';
import { serializeUser } from '@/utils/serializers';
import { buildUniqueUsername } from '@/utils/usernames';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (query.search) {
        const regex = new RegExp(String(query.search), 'i');
        filter.$or = [{ fullname: regex }, { email: regex }, { phone: regex }, { username: regex }];
    }

    if (query.role) filter.role = query.role;
    if (query.plantId) filter.plantId = query.plantId;
    if (query.isActive != null) filter.isActive = String(query.isActive) === 'true';

    return filter;
};

const ensureEmailAvailable = async (email: string, excludeId?: string) => {
    const existingUser = await User.findOne({
        email,
        isDeleted: { $ne: true },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
        .select('_id email')
        .lean();

    if (existingUser) {
        throw new DuplicateError('Email da ton tai');
    }
};

export const getAllUsers = async (req: Request, res: Response, next: NextFunction) => {
    const users = await User.find(buildFilter(req.query))
        .populate('plantId')
        .sort(String(req.query.sort || 'fullname'));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: users.map(serializeUser),
            message: 'Lay danh sach nguoi dung thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getUserById = async (req: Request, res: Response, next: NextFunction) => {
    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).populate('plantId');

    if (!user) throw new NotFoundError('Khong tim thay nguoi dung');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeUser(user),
            message: 'Lay thong tin nguoi dung thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
    const email = String(req.body.email).toLowerCase();
    await ensureEmailAvailable(email);

    const username = await buildUniqueUsername(req.body.name ?? email.split('@')[0]);
    const user = await User.create({
        fullname: req.body.name,
        username,
        email,
        password: req.body.password,
        phone: req.body.phone,
        role: req.body.role,
        plantId: req.body.plantId,
        avatarUrl: req.body.avatarUrl,
        isActive: req.body.isActive ?? true,
    });

    const createdUser = await User.findById(user._id).populate('plantId');

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeUser(createdUser),
            message: 'Tao nguoi dung thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updateUser = async (req: Request, res: Response, next: NextFunction) => {
    const userId = String(req.params.id);
    const normalizedEmail = req.body.email ? String(req.body.email).toLowerCase() : undefined;

    if (normalizedEmail) {
        await ensureEmailAvailable(normalizedEmail, userId);
    }

    const updateData: Record<string, any> = {
        email: normalizedEmail,
        phone: req.body.phone,
        role: req.body.role,
        plantId: req.body.plantId,
        avatarUrl: req.body.avatarUrl,
        isActive: req.body.isActive,
    };

    if (req.body.name) {
        updateData.fullname = req.body.name;
    }

    Object.keys(updateData).forEach((key) => updateData[key] === undefined && delete updateData[key]);

    const user = await User.findOneAndUpdate({ _id: userId, isDeleted: { $ne: true } }, updateData, {
        returnDocument: 'after',
        runValidators: true,
    }).populate('plantId');

    if (!user) throw new NotFoundError('Khong tim thay nguoi dung');

    if (updateData.isActive === false) {
        await revokeUserSessions(userId);
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeUser(user),
            message: 'Cap nhat nguoi dung thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction) => {
    if (req.userId && req.userId === req.params.id) {
        throw new BadRequestError('Khong the xoa chinh tai khoan dang dang nhap');
    }

    const user = await User.findOneAndUpdate(
        { _id: req.params.id, isDeleted: { $ne: true } },
        { isDeleted: true, deletedAt: new Date(), isActive: false },
        { returnDocument: 'after' }
    );

    if (!user) throw new NotFoundError('Khong tim thay nguoi dung');

    await revokeUserSessions(String(user._id));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Xoa nguoi dung thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        throw new NotFoundError('Khong tim thay nguoi dung');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeUser(req.user),
            message: 'Lay thong tin ca nhan thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
