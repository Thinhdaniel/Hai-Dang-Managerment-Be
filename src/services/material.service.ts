import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import { materialRepository } from '@/repositories/material.repository';
import { buildPlantScopeFilter, getUserPlantId, isManagerRole, toId } from '@/services/material-workflow.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import {
    serializeInventoryStock,
    serializeMaterial,
    serializePurchaseOrder,
    serializePurchaseRequest,
} from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const ensureMaterialCodeAvailable = async (code?: string, excludeId?: string) => {
    const normalizedCode = code?.trim();

    if (!normalizedCode) {
        return;
    }

    const existingMaterial = await Material.findOne({
        code: normalizedCode,
        isDeleted: { $ne: true },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
        .select('_id code')
        .lean();

    if (existingMaterial) {
        throw new DuplicateError('Ma vat tu da ton tai');
    }
};

const buildMaterialFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [{ name: regex }, { code: regex }];
    }

    if (query.category) {
        filter.category = query.category;
    }

    if (query.isActive != null) {
        filter.isActive = String(query.isActive) === 'true';
    }

    return filter;
};

const getStockTotalsByMaterial = async (materialIds: string[], plantId?: string) => {
    if (!materialIds.length) {
        return new Map<string, number>();
    }

    const matchStage: Record<string, any> = {
        isDeleted: { $ne: true },
        materialId: { $in: materialIds.map((id) => new mongoose.Types.ObjectId(id)) },
    };

    if (plantId) {
        matchStage.plantId = new mongoose.Types.ObjectId(plantId);
    }

    const rows = await InventoryStock.aggregate<{ _id: any; totalCurrentStock: number }>([
        { $match: matchStage },
        {
            $group: {
                _id: '$materialId',
                totalCurrentStock: { $sum: '$currentStock' },
            },
        },
    ]);

    return new Map(rows.map((row) => [String(row._id), row.totalCurrentStock]));
};

const getLowStockMaterialsData = async (req: Request, category?: string) => {
    const plantId = isManagerRole(req.role) ? (req.query.plantId ? String(req.query.plantId) : undefined) : getUserPlantId(req);
    const materials = await materialRepository.findMany({
        isDeleted: { $ne: true },
        isActive: { $ne: false },
        ...(category ? { category } : {}),
    });

    const stockTotals = await getStockTotalsByMaterial(
        materials.map((material: any) => String(material._id)),
        plantId
    );

    return materials
        .map((material) => {
            const totalCurrentStock = stockTotals.get(String((material as any)._id)) ?? 0;
            return {
                ...material.toObject(),
                totalCurrentStock,
                lowStock: totalCurrentStock < (material.minStockLevel ?? 0),
            };
        })
        .filter((material) => material.lowStock);
};

const getPurchaseOrdersByPlant = async (plantId?: string) => {
    const orders = await PurchaseOrder.find({ isDeleted: { $ne: true } }).populate('requestIds').populate('supplierId');

    if (!plantId) {
        return orders;
    }

    return orders.filter((order: any) =>
        (order.requestIds ?? []).some((request: any) => String(request.plantId) === plantId)
    );
};

const getOrderEffectiveDate = (order: any) => new Date(order.receivedAt || order.orderedAt || order.createdAt);

export const getAllMaterials = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildMaterialFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || 'name')
        .split(',')
        .join(' ');

    const [materials, total] = await Promise.all([
        materialRepository.findMany(filter, { sort, skip, limit }),
        materialRepository.countDocuments(filter),
    ]);

    const stockPlantId = isManagerRole(req.role)
        ? req.query.plantId
            ? String(req.query.plantId)
            : undefined
        : getUserPlantId(req);
    const stockTotals = await getStockTotalsByMaterial(
        materials.map((material: any) => String(material._id)),
        stockPlantId
    );

    // includeStock=true: thêm isAvailableAtCS1 + cs1CurrentStock cho FE SR modal
    let cs1StockMap: Map<string, number> | null = null;
    if (req.query.includeStock === 'true') {
        const mainPlantId = process.env.MAIN_PLANT_ID;
        if (mainPlantId) {
            cs1StockMap = await getStockTotalsByMaterial(
                materials.map((m: any) => String(m._id)),
                mainPlantId
            );
        }
    }

    const serializedMaterials = materials.map((material) => {
        const base = serializeMaterial({
            ...material.toObject(),
            totalCurrentStock: stockTotals.get(String((material as any)._id)) ?? 0,
        });
        if (cs1StockMap) {
            const cs1Stock = cs1StockMap.get(String((material as any)._id)) ?? 0;
            return { ...base, cs1CurrentStock: cs1Stock, isAvailableAtCS1: cs1Stock > 0 };
        }
        return base;
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(serializedMaterials, total, page, limit),
            message: 'Lay danh muc vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getMaterialById = async (req: Request, res: Response, next: NextFunction) => {
    const material = await materialRepository.findById(String(req.params.id));

    if (!material) {
        throw new NotFoundError('Khong tim thay vat tu');
    }

    const stockPlantFilter = buildPlantScopeFilter(req);
    const inventoryStocks = await (InventoryStock as any).find({
        materialId: req.params.id,
        isDeleted: { $ne: true },
        ...stockPlantFilter,
    })
        .populate('materialId')
        .populate('plantId');

    const totalCurrentStock = inventoryStocks.reduce((sum: number, stock: any) => sum + Number(stock.currentStock ?? 0), 0);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                ...serializeMaterial({
                    ...material.toObject(),
                    totalCurrentStock,
                }),
                inventoryByPlant: inventoryStocks.map(serializeInventoryStock),
            },
            message: 'Lay chi tiet vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createMaterial = async (req: Request, res: Response, next: NextFunction) => {
    await ensureMaterialCodeAvailable(req.body.code);

    const material = await materialRepository.create({
        ...req.body,
        code: req.body.code?.trim() || undefined,
        createdBy: req.userId,
        updatedBy: req.userId,
    });

    const createdMaterial = await materialRepository.findById(String(material._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeMaterial(createdMaterial),
            message: 'Tao vat tu thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updateMaterial = async (req: Request, res: Response, next: NextFunction) => {
    await ensureMaterialCodeAvailable(req.body.code, String(req.params.id));

    const material = await materialRepository.updateById(String(req.params.id), {
        ...req.body,
        code: req.body.code?.trim() || undefined,
        updatedBy: req.userId,
    });

    if (!material) {
        throw new NotFoundError('Khong tim thay vat tu');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeMaterial(material),
            message: 'Cap nhat vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteMaterial = async (req: Request, res: Response, next: NextFunction) => {
    const material = await materialRepository.softDeleteById(String(req.params.id), {
        isActive: false,
        isDeleted: true,
        deletedAt: new Date(),
        updatedBy: req.userId,
    });

    if (!material) {
        throw new NotFoundError('Khong tim thay vat tu');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Xoa vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getLowStockMaterials = async (req: Request, res: Response, next: NextFunction) => {
    const materials = await getLowStockMaterialsData(req, req.query.category ? String(req.query.category) : undefined);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: materials.map(serializeMaterial),
            message: 'Lay danh sach vat tu duoi nguong ton kho thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getMaterialReportsSummary = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [totalMaterials, pendingRequestCount, lowStockMaterials, purchaseOrders] = await Promise.all([
        Material.countDocuments({ isDeleted: { $ne: true }, isActive: { $ne: false } }),
        PurchaseRequest.countDocuments({
            isDeleted: { $ne: true },
            status: 'pending',
            ...(plantId ? { plantId } : {}),
        }),
        getLowStockMaterialsData(req),
        getPurchaseOrdersByPlant(plantId),
    ]);

    const totalMonthlyCost = purchaseOrders
        .filter((order) => {
            const orderDate = getOrderEffectiveDate(order);
            return orderDate >= monthStart && orderDate < monthEnd;
        })
        .reduce((sum, order: any) => sum + (order.totalAmount ?? 0), 0);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                totalMaterials,
                totalMonthlyCost: Number(totalMonthlyCost.toFixed(2)),
                pendingRequestCount,
                lowStockCount: lowStockMaterials.length,
            },
            message: 'Lay bao cao tong quan vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getMaterialCostByPeriodReport = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const year = Number(req.query.year) || new Date().getFullYear();
    const period = req.query.period === 'quarter' ? 'quarter' : 'month';

    const purchaseOrders = await getPurchaseOrdersByPlant(plantId);

    const groupedData = purchaseOrders.reduce(
        (result: Record<string, number>, order: any) => {
            const orderDate = getOrderEffectiveDate(order);

            if (orderDate.getFullYear() !== year) {
                return result;
            }

            const key =
                period === 'quarter'
                    ? `${year}-Q${Math.floor(orderDate.getMonth() / 3) + 1}`
                    : `${year}-${String(orderDate.getMonth() + 1).padStart(2, '0')}`;

            result[key] = Number(((result[key] ?? 0) + (order.totalAmount ?? 0)).toFixed(2));
            return result;
        },
        {}
    );

    const data = Object.entries(groupedData)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([label, totalAmount]) => ({
            period: label,
            totalAmount,
        }));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Lay bao cao chi phi theo ky thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getMaterialReportBySupplier = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const purchaseOrders = await getPurchaseOrdersByPlant(plantId);

    const groupedData = purchaseOrders.reduce(
        (result: Record<string, { supplierId?: string; supplierName: string; totalAmount: number; orderCount: number }>, order: any) => {
            const supplierId = toId(order.supplierId);
            const supplierName = order.supplierName || order.supplierId?.name || 'Chua gan nha cung cap';
            const key = supplierId || supplierName;

            if (!result[key]) {
                result[key] = { supplierId, supplierName, totalAmount: 0, orderCount: 0 };
            }

            result[key].totalAmount = Number((result[key].totalAmount + (order.totalAmount ?? 0)).toFixed(2));
            result[key].orderCount += 1;

            return result;
        },
        {}
    );

    // Thêm dữ liệu từ PurchaseRequest items có supplierId
    const prMatchFilter: Record<string, any> = { isDeleted: { $ne: true }, 'items.supplierId': { $exists: true } };
    if (plantId) prMatchFilter.plantId = new mongoose.Types.ObjectId(plantId);

    const prAgg = await PurchaseRequest.aggregate([
        { $match: prMatchFilter },
        { $unwind: '$items' },
        { $match: { 'items.supplierId': { $exists: true, $ne: null } } },
        {
            $group: {
                _id: '$items.supplierId',
                supplierName: { $first: '$items.supplierName' },
                totalAmount: { $sum: { $ifNull: ['$items.totalWithVat', 0] } },
                orderCount: { $addToSet: '$_id' },
            },
        },
        { $sort: { totalAmount: -1 } },
    ]);

    prAgg.forEach((row: any) => {
        const key = String(row._id);
        if (!groupedData[key]) {
            groupedData[key] = {
                supplierId: key,
                supplierName: row.supplierName || key,
                totalAmount: 0,
                orderCount: 0,
            };
        }
        groupedData[key].totalAmount = Number((groupedData[key].totalAmount + row.totalAmount).toFixed(2));
        groupedData[key].orderCount += row.orderCount.length;
    });

    const data = Object.values(groupedData).sort((a, b) => b.totalAmount - a.totalAmount);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Lay bao cao chi phi theo nha cung cap thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getMaterialPriceComparisonReport = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const purchaseOrders = await getPurchaseOrdersByPlant(plantId);

    const data = purchaseOrders.map((order: any) => {
        const estimatedTotal = (order.requestIds ?? []).reduce(
            (sum: number, request: any) => sum + (request.totalEstimated ?? 0),
            0
        );
        const actualTotal = Number(order.totalAmount ?? 0);

        return {
            orderId: String(order._id),
            orderCode: order.orderCode,
            supplierId: toId(order.supplierId),
            supplierName: order.supplierName || order.supplierId?.name || 'Chua gan nha cung cap',
            requestCodes: (order.requestIds ?? []).map((request: any) => request.requestCode),
            estimatedTotal: Number(estimatedTotal.toFixed(2)),
            actualTotal: Number(actualTotal.toFixed(2)),
            difference: Number((actualTotal - estimatedTotal).toFixed(2)),
            orderedAt: order.orderedAt ? new Date(order.orderedAt).toISOString() : undefined,
            receivedAt: order.receivedAt ? new Date(order.receivedAt).toISOString() : undefined,
            status: order.status,
        };
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Lay bao cao so sanh gia de xuat va gia thuc te thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
