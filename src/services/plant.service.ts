import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import { assetRepository } from '@/repositories/asset.repository';
import { plantRepository } from '@/repositories/plant.repository';
import { buildSearchRegex } from '@/utils/search';
import customResponse from '@/utils/response';
import { serializePlant } from '@/utils/serializers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const buildFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    const regex = buildSearchRegex(query.search);

    if (regex) {
        filter.$or = [{ name: regex }, { code: regex }, { address: regex }];
    }

    return filter;
};

const normalizePlantName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

const sanitizePlantPayload = (payload: Record<string, any>) => {
    const sanitizedName = payload.name?.trim().replace(/\s+/g, ' ');
    const sanitizedCode = payload.code?.trim().replace(/\s+/g, ' ');
    const sanitizedAddress = payload.address?.trim().replace(/\s+/g, ' ');
    const sanitizedPhone = payload.phone?.trim().replace(/\s+/g, ' ');

    return {
        ...payload,
        ...(sanitizedName ? { name: sanitizedName, normalizedName: normalizePlantName(sanitizedName) } : {}),
        ...(sanitizedCode ? { code: sanitizedCode } : {}),
        ...(payload.address !== undefined ? { address: sanitizedAddress || undefined } : {}),
        ...(payload.phone !== undefined ? { phone: sanitizedPhone || undefined } : {}),
    };
};

const ensurePlantNameAvailable = async (name: string, excludeId?: string) => {
    const existingPlant = await plantRepository.findNameConflict({
        normalizedName: normalizePlantName(name),
        excludeId,
    });

    if (existingPlant) {
        throw new DuplicateError('Ten co so da ton tai');
    }
};

const attachAssetCounts = async (plants: any[]) => {
    const plantIds = plants.map((plant) => String(plant._id ?? plant.id));
    const assetCounts = await assetRepository.countGroupedByPlantIds(plantIds);

    return plants.map((plant) => {
        const plainPlant = typeof plant?.toObject === 'function' ? plant.toObject() : plant;

        return {
            ...plainPlant,
            assetCount: assetCounts.get(String(plainPlant?._id ?? plainPlant?.id)) ?? 0,
        };
    });
};

const attachMachineCounts = (plants: any[], countsByPlant: Map<string, number>) => {
    return plants.map((plant) => {
        const plainPlant = typeof plant?.toObject === 'function' ? plant.toObject() : plant;
        const machineCount = countsByPlant.get(String(plainPlant?._id ?? plainPlant?.id)) ?? 0;

        return {
            ...plainPlant,
            assetCount: machineCount,
            machineCount,
        };
    });
};

export const createPlant = async (req: Request, res: Response, next: NextFunction) => {
    const payload = sanitizePlantPayload(req.body);

    await ensurePlantNameAvailable(payload.name);

    const plant = await plantRepository.create({ ...payload, createdBy: req.userId, updatedBy: req.userId });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializePlant(plant),
            message: 'Tao co so thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const getAllPlants = async (req: Request, res: Response, next: NextFunction) => {
    const plants = await plantRepository.findMany(buildFilter(req.query), { sort: String(req.query.sort || 'name') });
    const plantsWithCounts = await attachAssetCounts(plants);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: plantsWithCounts.map(serializePlant),
            message: 'Lay danh sach co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPlantsWithMachineCount = async (req: Request, res: Response, next: NextFunction) => {
    const plants = await plantRepository.findMany(buildFilter(req.query), { sort: String(req.query.sort || 'name') });
    const machineStats = await assetRepository.getPlantMachineStats();
    const facilities = attachMachineCounts(plants, machineStats.countsByPlant).map(serializePlant);
    const totalMachines = facilities.reduce((sum, facility) => sum + (facility.machineCount ?? facility.assetCount ?? 0), 0);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                facilities,
                summary: {
                    totalFacilities: facilities.length,
                    totalMachines,
                    unassignedMachines: machineStats.unassignedMachines,
                },
            },
            message: 'Lay thong ke co so va so luong thiet bi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPlantById = async (req: Request, res: Response, next: NextFunction) => {
    const plant = await plantRepository.findById(String(req.params.id));

    if (!plant) throw new NotFoundError('Khong tim thay co so');

    const [plantWithCounts] = await attachAssetCounts([plant]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePlant(plantWithCounts),
            message: 'Lay thong tin co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updatePlant = async (req: Request, res: Response, next: NextFunction) => {
    const payload = sanitizePlantPayload(req.body);
    const plantId = String(req.params.id);

    if (payload.name) {
        await ensurePlantNameAvailable(payload.name, plantId);
    }

    const plant = await plantRepository.updateById(plantId, { ...payload, updatedBy: req.userId });

    if (!plant) throw new NotFoundError('Khong tim thay co so');

    const [plantWithCounts] = await attachAssetCounts([plant]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePlant(plantWithCounts),
            message: 'Cap nhat co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deletePlant = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = String(req.params.id);
    const linkedAssetCount = await assetRepository.countDocuments({
        isDeleted: { $ne: true },
        plantId,
    });

    if (linkedAssetCount > 0) {
        throw new BadRequestError('Khong the xoa co so dang duoc gan cho thiet bi');
    }

    const plant = await plantRepository.softDeleteById(plantId, {
        isDeleted: true,
        deletedAt: new Date(),
    });

    if (!plant) throw new NotFoundError('Khong tim thay co so');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Xoa co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
