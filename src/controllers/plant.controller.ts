import { plantService } from '@/services';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const createPlant = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await plantService.createPlant(req, res, next);
});

export const getAllPlants = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await plantService.getAllPlants(req, res, next);
});

export const getPlantsWithMachineCount = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await plantService.getPlantsWithMachineCount(req, res, next);
});

export const getPlantById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await plantService.getPlantById(req, res, next);
});

export const updatePlant = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await plantService.updatePlant(req, res, next);
});

export const deletePlant = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await plantService.deletePlant(req, res, next);
});
