import ExcelJS from 'exceljs';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { emitToAll } from '@/lib/socket';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { assetRepository } from '@/repositories/asset.repository';
import { confirmAssetImport, previewAssetImport } from '@/services/asset-import.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import { generateUniqueMachinePublicId } from '@/utils/publicId';
import { buildSearchRegex } from '@/utils/search';
import { serializeAsset, serializePublicAsset } from '@/utils/serializers';
import Transfer from '@/models/Transfer';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import customResponse from '@/utils/response';

const ASSET_SOCKET_EVENTS = {
    CREATED: 'asset:created',
    UPDATED: 'asset:updated',
    DELETED: 'asset:deleted',
} as const;

const broadcastAssetChange = (
    event: (typeof ASSET_SOCKET_EVENTS)[keyof typeof ASSET_SOCKET_EVENTS],
    asset: unknown,
    action: string,
    changedFields: string[] = []
) => {
    if (!asset) return;

    const serializedAsset = serializeAsset(asset);

    emitToAll(event, {
        action,
        assetId: serializedAsset.id,
        asset: serializedAsset,
        changedFields,
        updatedAt: serializedAsset.updatedAt ?? new Date().toISOString(),
    });
};

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
    if (query.ownershipType) {
        if (query.ownershipType === ASSET_OWNERSHIP_TYPE.OWNED) {
            andConditions.push({
                $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
            });
        } else {
            filter.ownershipType = query.ownershipType;
        }
    }
    if (query.plantId) filter.plantId = query.plantId;
    if (query.name) filter.name = query.name;
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

const assertValidAssetOwnershipStatus = (status?: string, ownershipType?: string) => {
    const normalizedOwnershipType = ownershipType || ASSET_OWNERSHIP_TYPE.OWNED;
    if (status === ASSET_STATUS.RETURNED_TO_PARTNER && normalizedOwnershipType === ASSET_OWNERSHIP_TYPE.OWNED) {
        throw new BadRequestError('May da tra doi tac phai la may muon doi tac hoac may thue');
    }
};

export const createAsset = async (req: Request, res: Response, next: NextFunction) => {
    assertValidAssetOwnershipStatus(req.body.status, req.body.ownershipType);

    const asset = await assetRepository.create({
        ...req.body,
        publicId: await createAvailablePublicId(),
        createdBy: req.userId,
        updatedBy: req.userId,
        status: req.body.status ?? ASSET_STATUS.ACTIVE,
        ownershipType: req.body.ownershipType ?? ASSET_OWNERSHIP_TYPE.OWNED,
    });

    const createdAsset = await assetRepository.findById(String(asset._id));
    broadcastAssetChange(ASSET_SOCKET_EVENTS.CREATED, createdAsset, 'created', ['created']);

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

    const assetIds = assets.map((a) => a._id);
    const openTransfers = await Transfer.find({
        isDeleted: { $ne: true },
        status: { $in: ['pending', 'approved'] },
        $or: [{ assetId: { $in: assetIds } }, { assetIds: { $in: assetIds } }],
    }).select('assetId assetIds');

    const openTransferIds = new Set(
        openTransfers
            .flatMap((transfer: any) => [
                transfer.assetId ? String(transfer.assetId) : undefined,
                ...(Array.isArray(transfer.assetIds) ? transfer.assetIds.map(String) : []),
            ])
            .filter(Boolean)
    );

    const serializedAssets = assets.map((a) => ({
        ...serializeAsset(a),
        hasOpenTransfer: openTransferIds.has(String(a._id)),
    }));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(serializedAssets, total, page, limit),
            message: 'Lay danh sach thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportAssets = async (req: Request, res: Response, next: NextFunction) => {
    const assets = await assetRepository.findMany(buildFilter(req.query), { sort: '-createdAt' });
    const rows = assets.map(serializeAsset);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Device Management System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Thiết bị');

    // Define columns
    sheet.columns = [
        { header: 'Tên máy', key: 'name', width: 30 },
        { header: 'Mã máy', key: 'machineCode', width: 18 },
        { header: 'Serial', key: 'serial', width: 20 },
        { header: 'Loại máy', key: 'type', width: 20 },
        { header: 'Model máy', key: 'model', width: 20 },
        { header: 'Trạng thái', key: 'status', width: 16 },
        { header: 'Nguồn gốc', key: 'ownershipType', width: 18 },
        { header: 'Nhãn hiệu', key: 'brand', width: 20 },
        { header: 'Cơ sở', key: 'plant', width: 20 },
        { header: 'Ngày mua', key: 'purchaseDate', width: 15 },
        { header: 'Giá trị', key: 'purchasePrice', width: 15 },
    ];

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;

    // Add data rows
    rows.forEach((row) => {
        sheet.addRow({
            name: row.name ?? '',
            machineCode: row.machineCode ?? '',
            serial: row.serial ?? '',
            type: row.type ?? '',
            model: row.model ?? '',
            status: row.status ?? '',
            ownershipType: row.ownershipType ?? '',
            brand: row.brand?.name ?? '',
            plant: row.plant?.name ?? '',
            purchaseDate: row.purchaseDate ?? '',
            purchasePrice: row.purchasePrice ?? '',
        });
    });

    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.xlsx"');
    return res.status(StatusCodes.OK).send(buffer);
};

export const getAssetById = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await assetRepository.findById(String(req.params.id));

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    const openTransfer = await Transfer.findOne({
        isDeleted: { $ne: true },
        status: { $in: ['pending', 'approved'] },
        $or: [{ assetId: asset._id }, { assetIds: asset._id }],
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                ...serializeAsset(asset),
                hasOpenTransfer: !!openTransfer,
            },
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

    broadcastAssetChange(ASSET_SOCKET_EVENTS.UPDATED, updatedAsset, 'public-id-updated', ['publicId']);

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
    const currentAsset = await assetRepository.findById(String(req.params.id));
    if (!currentAsset) throw new NotFoundError('Khong tim thay thiet bi');

    assertValidAssetOwnershipStatus(
        req.body.status ?? currentAsset.status,
        req.body.ownershipType ?? currentAsset.ownershipType
    );

    const asset = await assetRepository.updateById(String(req.params.id), { ...req.body, updatedBy: req.userId });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');
    broadcastAssetChange(ASSET_SOCKET_EVENTS.UPDATED, asset, 'updated', Object.keys(req.body));

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
    const currentAsset = await assetRepository.findById(String(req.params.id));
    if (!currentAsset) throw new NotFoundError('Khong tim thay thiet bi');

    assertValidAssetOwnershipStatus(req.body.status, currentAsset.ownershipType);

    const asset = await assetRepository.updateById(String(req.params.id), {
        status: req.body.status,
        statusNote: req.body.note,
        updatedBy: req.userId,
    });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');
    broadcastAssetChange(ASSET_SOCKET_EVENTS.UPDATED, asset, 'status-updated', ['status', 'statusNote']);

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
    broadcastAssetChange(ASSET_SOCKET_EVENTS.DELETED, asset, 'deleted', ['isDeleted']);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Xoa thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getAssetNames = async (req: Request, res: Response, next: NextFunction) => {
    const names = await assetRepository.getDistinctNames();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: names,
            message: 'Danh sách tên máy',
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

export const getAssetTypes = async (req: Request, res: Response, next: NextFunction) => {
    const types = await assetRepository.getDistinctTypes();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: types,
            message: 'Lay danh sach loai may thanh cong',
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
