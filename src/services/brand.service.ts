import { DuplicateError, NotFoundError } from '@/errors/customError';
import Brand from '@/models/Brand';
import customResponse from '@/utils/response';
import { serializeBrand } from '@/utils/serializers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (query.search) {
        const regex = new RegExp(String(query.search), 'i');
        filter.$or = [{ name: regex }, { description: regex }];
    }

    return filter;
};

const normalizeBrandName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

const sanitizeBrandPayload = (payload: Record<string, any>) => {
    const sanitizedName = payload.name?.trim().replace(/\s+/g, ' ');
    const sanitizedDescription = payload.description?.trim().replace(/\s+/g, ' ');

    return {
        ...payload,
        ...(sanitizedName ? { name: sanitizedName, normalizedName: normalizeBrandName(sanitizedName) } : {}),
        ...(payload.description !== undefined ? { description: sanitizedDescription || undefined } : {}),
    };
};

const ensureBrandNameAvailable = async (name: string, excludeId?: string) => {
    const normalizedName = normalizeBrandName(name);
    const escapedName = name
        .trim()
        .replace(/\s+/g, ' ')
        .split(' ')
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
    const existingBrand = await Brand.findOne({
        $or: [{ normalizedName }, { name: new RegExp(`^${escapedName}$`, 'i') }],
        isDeleted: { $ne: true },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
        .select('_id name')
        .lean();

    if (existingBrand) {
        throw new DuplicateError('Ten nhan hieu da ton tai');
    }
};

export const createBrand = async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.userId;
    const payload = sanitizeBrandPayload(req.body);

    await ensureBrandNameAvailable(payload.name);

    const brand = await Brand.create({ ...payload, createdBy: userId, updatedBy: userId });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeBrand(brand),
            message: 'Tao nhan hieu thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const getAllBrands = async (req: Request, res: Response, next: NextFunction) => {
    const brands = await Brand.find(buildFilter(req.query)).sort(String(req.query.sort || 'name'));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: brands.map(serializeBrand),
            message: 'Lay danh sach nhan hieu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getBrandById = async (req: Request, res: Response, next: NextFunction) => {
    const brand = await Brand.findOne({ _id: req.params.id, isDeleted: { $ne: true } });

    if (!brand) throw new NotFoundError('Khong tim thay nhan hieu');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeBrand(brand),
            message: 'Lay thong tin nhan hieu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updateBrand = async (req: Request, res: Response, next: NextFunction) => {
    const payload = sanitizeBrandPayload(req.body);

    if (payload.name) {
        await ensureBrandNameAvailable(payload.name, String(req.params.id));
    }

    const brand = await Brand.findOneAndUpdate(
        { _id: req.params.id, isDeleted: { $ne: true } },
        { ...payload, updatedBy: req.userId },
        { returnDocument: 'after', runValidators: true }
    );

    if (!brand) throw new NotFoundError('Khong tim thay nhan hieu');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeBrand(brand),
            message: 'Cap nhat nhan hieu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteBrand = async (req: Request, res: Response, next: NextFunction) => {
    const brand = await Brand.findOneAndUpdate(
        { _id: req.params.id, isDeleted: { $ne: true } },
        { isDeleted: true, deletedAt: new Date() },
        { returnDocument: 'after' }
    );

    if (!brand) throw new NotFoundError('Khong tim thay nhan hieu');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Xoa nhan hieu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
