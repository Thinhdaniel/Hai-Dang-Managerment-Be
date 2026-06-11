import { ACCESS_MESSAGES } from '@/constant/messages';
import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
import StockTransaction from '@/models/StockTransaction';
import type { ClientSession, Model } from 'mongoose';
import type { Request } from 'express';

type MongooseDocument = {
    _id?: unknown;
    [key: string]: unknown;
};

export const toId = (value: unknown) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value && '_id' in value) {
        return String((value as Record<string, unknown>)._id);
    }
    return String(value);
};

export const isManagerRole = (role?: string) =>
    role === USER_ROLE.ADMIN || role === USER_ROLE.MANAGER || role === USER_ROLE.DIRECTOR;

export const getUserPlantId = (req: Request) => {
    const plantValue =
        req.user && typeof req.user === 'object' && 'plantId' in req.user
            ? (req.user as Record<string, unknown>).plantId
            : undefined;

    return toId(plantValue);
};

export const requireUserPlantId = (req: Request) => {
    const plantId = getUserPlantId(req);

    if (!plantId) {
        throw new BadRequestError('Nguoi dung chua duoc gan co so');
    }

    return plantId;
};

export const assertPlantAccess = (req: Request, plantId?: string | null) => {
    if (isManagerRole(req.role)) {
        return;
    }

    const userPlantId = requireUserPlantId(req);

    if (!plantId || userPlantId !== String(plantId)) {
        throw new UnAuthorizedError(ACCESS_MESSAGES.PERMISSION_DENIED);
    }
};

export const buildPlantScopeFilter = (req: Request, field = 'plantId') => {
    if (isManagerRole(req.role)) {
        return {};
    }

    return {
        [field]: requireUserPlantId(req),
    };
};

export const ensurePlantExists = async (plantId: string, session?: ClientSession) => {
    const query = Plant.findOne({ _id: plantId, isDeleted: { $ne: true } });
    if (session) {
        query.session(session);
    }

    const plant = await query;

    if (!plant) {
        throw new NotFoundError('Khong tim thay co so');
    }

    return plant;
};

export const ensureMaterialExists = async (materialId: string, session?: ClientSession) => {
    const query = Material.findOne({ _id: materialId, isDeleted: { $ne: true } });
    if (session) {
        query.session(session);
    }

    const material = await query;

    if (!material) {
        throw new NotFoundError('Khong tim thay vat tu');
    }

    return material;
};

export const generateDocumentCode = async ({
    model,
    field,
    prefix,
    session,
}: {
    model: Model<any>;
    field: string;
    prefix: string;
    session?: ClientSession;
}) => {
    const { generateCode } = await import('@/utils/codeGenerator');
    return generateCode({ model, field, prefix, session });
};

export const computeLineTotal = (quantity: number, unitPrice?: number | null) => {
    return Number((quantity * (unitPrice ?? 0)).toFixed(2));
};

export const applyStockMovement = async ({
    materialId,
    materialName,
    plantId,
    quantity,
    type,
    relatedId,
    relatedType,
    performedBy,
    note,
    session,
}: {
    materialId: string;
    materialName: string;
    plantId: string;
    quantity: number;
    type: 'import' | 'export' | 'adjust';
    relatedId?: string;
    relatedType: 'purchase_order' | 'distribution' | 'manual';
    performedBy?: string;
    note?: string;
    session: ClientSession;
}) => {
    const inventoryStock: any =
        (await (InventoryStock as any)
            .findOne({
                materialId,
                plantId,
                isDeleted: { $ne: true },
            })
            .session(session)) ||
        new (InventoryStock as any)({
            materialId,
            plantId,
            currentStock: 0,
        });

    const stockBefore = Number(inventoryStock.currentStock ?? 0);
    const stockAfter = stockBefore + quantity;

    if (stockAfter < 0) {
        throw new BadRequestError(`Ton kho vat tu "${materialName}" khong du de thuc hien giao dich`);
    }

    inventoryStock.currentStock = stockAfter;
    await inventoryStock.save({ session });

    const transaction = new StockTransaction({
        type,
        materialId,
        materialName,
        plantId,
        quantity,
        stockBefore,
        stockAfter,
        relatedId,
        relatedType,
        performedBy,
        note,
    });

    await transaction.save({ session });

    return {
        inventoryStock,
        transaction,
    };
};
