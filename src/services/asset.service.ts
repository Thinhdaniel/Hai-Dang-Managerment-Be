import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { assetRepository } from '@/repositories/asset.repository';
import { confirmAssetImport, previewAssetImport } from '@/services/asset-import.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import { generateUniqueMachinePublicId } from '@/utils/publicId';
import { buildSearchRegex } from '@/utils/search';
import { serializeAsset, serializePublicAsset } from '@/utils/serializers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import customResponse from '@/utils/response';

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const andConditions: Record<string, any>[] = [];

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        andConditions.push({
            $or: [{ name: regex }, { machineCode: regex }, { serial: regex }, { type: regex }, { model: regex }],
        });
    }

    if (query.status) filter.status = query.status;
    if (query.plantId) filter.plantId = query.plantId;
    if (query.model) {
        andConditions.push({
            $or: [
                { model: query.model },
                { model: { $exists: false }, type: query.model },
                { model: null, type: query.model },
                { model: '', type: query.model },
            ],
        });
    }
    if (query.type) filter.type = query.type;
    if (query.brandId) filter.brandId = query.brandId;

    if (andConditions.length) {
        filter.$and = andConditions;
    }

    return filter;
};

const createAvailablePublicId = async () => {
    return generateUniqueMachinePublicId(async (publicId) => Boolean(await assetRepository.existsByPublicId(publicId)));
};

export const createAsset = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.create({
        ...req.body,
        publicId: await createAvailablePublicId(),
        createdBy: req.userId,
        updatedBy: req.userId,
        status: req.body.status ?? ASSET_STATUS.ACTIVE,
    });

    const createdAsset = await assetRepository.findById(String(asset._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeAsset(createdAsset),
            message: 'Tao thiet bi thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const getAllAssets = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || '-createdAt')
        .split(',')
        .join(' ');

    const [assets, total] = await Promise.all([
        assetRepository.findMany(filter, { sort, skip, limit }),
        assetRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(assets.map(serializeAsset), total, page, limit),
            message: 'Lay danh sach thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportAssets = async (req: Request, res: Response, next: NextFunction) => {
    const assets = await assetRepository.findMany(buildFilter(req.query), { sort: '-createdAt' });
    const rows = assets.map(serializeAsset);
    const headers = [
        'Ten may',
        'Ma may',
        'Serial',
        'Loai may',
        'Model may',
        'Trang thai',
        'Nhan hieu',
        'Co so',
        'Ngay mua',
        'Gia tri',
    ];
    const csvRows = [
        headers.join(','),
        ...rows.map((row) =>
            [
                row.name,
                row.machineCode,
                row.serial,
                row.type,
                row.model,
                row.status,
                row.brand?.name ?? '',
                row.plant?.name ?? '',
                row.purchaseDate ?? '',
                row.purchasePrice ?? '',
            ]
                .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
                .join(',')
        ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');
    return res.status(StatusCodes.OK).send(`\uFEFF${csvRows.join('\n')}`);
};

export const getAssetById = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.findById(String(req.params.id));

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeAsset(asset),
            message: 'Lay thong tin thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const ensureAssetPublicId = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.findById(String(req.params.id));

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    if (asset.publicId) {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: { publicId: asset.publicId },
                message: 'Da lay public ID thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const updatedAsset = await assetRepository.updateById(String(req.params.id), {
        publicId: await createAvailablePublicId(),
        updatedBy: req.userId,
    });

    if (!updatedAsset?.publicId) {
        throw new NotFoundError('Khong tim thay thiet bi');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { publicId: updatedAsset.publicId },
            message: 'Da tao public ID thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPublicAssetByPublicId = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.findByPublicId(String(req.params.publicId).trim().toUpperCase());

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePublicAsset(asset),
            message: 'Lay thong tin thiet bi cong khai thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updateAsset = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.updateById(String(req.params.id), { ...req.body, updatedBy: req.userId });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeAsset(asset),
            message: 'Cap nhat thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updateAssetStatus = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.updateById(String(req.params.id), {
        status: req.body.status,
        statusNote: req.body.note,
        updatedBy: req.userId,
    });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeAsset(asset),
            message: 'Cap nhat trang thai thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteAsset = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.softDeleteById(String(req.params.id), {
        isDeleted: true,
        deletedAt: new Date(),
        updatedBy: req.userId,
    });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Xoa thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getAssetModels = async (req: Request, res: Response, next: NextFunction) => {
    const models = await assetRepository.getDistinctModels();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: models,
            message: 'Lay danh sach model may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const previewAssetImportFile = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file?.buffer) {
        throw new BadRequestError('Vui long tai len file Excel de xem truoc');
    }

    const preview = await previewAssetImport(req.file.buffer, req.userId);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: preview,
            message: 'Da phan tich file import thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const confirmAssetImportFile = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file?.buffer) {
        throw new BadRequestError('Vui long tai len file Excel de import');
    }

    const result = await confirmAssetImport(req.file.buffer, req.userId);

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: result,
            message: 'Import thiet bi tu file Excel thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};
