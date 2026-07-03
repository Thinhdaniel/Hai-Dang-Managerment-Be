import { USER_ROLE } from '@/constant/allowedRoles';
import { CAPEX_COST_TYPES } from '@/constant/materialCostType';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
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
    const plantId = isManagerRole(req.role)
        ? req.query.plantId
            ? String(req.query.plantId)
            : undefined
        : getUserPlantId(req);
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

const orderMatchesPlant = (order: any, plantId?: string) => {
    if (!plantId) return true;

    if (toId(order?.plantId) === plantId) return true;
    if ((order?.items ?? []).some((item: any) => toId(item?.plantId) === plantId)) return true;

    return (order?.purchaseRequestIds ?? []).some((request: any) => toId(request?.plantId) === plantId);
};

const getPurchaseOrdersByPlant = async (plantId?: string) => {
    const orders = await PurchaseOrder.find({ isDeleted: { $ne: true } }).populate('purchaseRequestIds');

    if (!plantId) {
        return orders;
    }

    return orders.filter((order: any) => orderMatchesPlant(order, plantId));
};

const getOrderEffectiveDate = (order: any) => new Date(order.receivedAt || order.orderedAt || order.createdAt);

type ReportGroupBy = 'day' | 'week' | 'month' | 'quarter';

type MaterialReportFilters = {
    plantId?: string;
    startDate?: Date;
    endDate?: Date;
    materialId?: string;
    category?: string;
    supplierId?: string;
    status?: string;
    groupBy: ReportGroupBy;
};

const parseDateStart = (value: unknown) => {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    date.setHours(0, 0, 0, 0);
    return date;
};

const parseDateEnd = (value: unknown) => {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    date.setHours(23, 59, 59, 999);
    return date;
};

const buildReportFilters = (query: Request['query']): MaterialReportFilters => {
    const groupBy = ['day', 'week', 'month', 'quarter'].includes(String(query.groupBy))
        ? (String(query.groupBy) as ReportGroupBy)
        : 'month';

    return {
        plantId: query.plantId ? String(query.plantId) : undefined,
        startDate: parseDateStart(query.startDate),
        endDate: parseDateEnd(query.endDate),
        materialId: query.materialId ? String(query.materialId) : undefined,
        category: query.category ? String(query.category) : undefined,
        supplierId: query.supplierId ? String(query.supplierId) : undefined,
        status: query.status ? String(query.status) : undefined,
        groupBy,
    };
};

const getMaterialIdsForReport = async (filters: MaterialReportFilters) => {
    const materialFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        isActive: { $ne: false },
    };

    if (filters.materialId) {
        materialFilter._id = filters.materialId;
    }

    if (filters.category) {
        materialFilter.category = filters.category;
    }

    if (!filters.materialId && !filters.category) {
        return undefined;
    }

    const materials = await Material.find(materialFilter).select('_id').lean();
    return new Set(materials.map((material: any) => String(material._id)));
};

const isDateInRange = (date: Date, filters: MaterialReportFilters) => {
    if (filters.startDate && date < filters.startDate) return false;
    if (filters.endDate && date > filters.endDate) return false;
    return true;
};

const getPeriodLabel = (date: Date, groupBy: ReportGroupBy) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (groupBy === 'day') return `${year}-${month}-${day}`;
    if (groupBy === 'week') {
        const firstDay = new Date(year, 0, 1);
        const pastDays = Math.floor((date.getTime() - firstDay.getTime()) / 86400000);
        const week = String(Math.ceil((pastDays + firstDay.getDay() + 1) / 7)).padStart(2, '0');
        return `${year}-W${week}`;
    }
    if (groupBy === 'quarter') return `${year}-Q${Math.floor(date.getMonth() / 3) + 1}`;
    return `${year}-${month}`;
};

const getSourcePurchaseRequest = (order: any, item: any) => {
    const requestId = toId(item.purchaseRequestId);
    const requests = order?.purchaseRequestIds ?? [];
    if (requestId) {
        const request = requests.find((entry: any) => toId(entry) === requestId);
        if (request) return request;
    }
    return requests.length === 1 ? requests[0] : undefined;
};

const getSourcePurchaseRequestItem = (order: any, item: any) => {
    const request = getSourcePurchaseRequest(order, item);
    const requestItems = request?.items ?? [];
    const materialId = toId(item.materialId);

    // Legacy PO items created before item-level plantId only keep PR id/name/material.
    // Prefer materialId, then materialName as a best-effort fallback for old data.
    return (
        requestItems.find((entry: any) => materialId && toId(entry.materialId) === materialId) ??
        requestItems.find((entry: any) => entry.materialName && entry.materialName === item.materialName)
    );
};

const getReportOrderItemPlantId = (order: any, item: any) => {
    const itemPlantId = toId(item.plantId);
    if (itemPlantId) return itemPlantId;

    const sourceItem = getSourcePurchaseRequestItem(order, item);
    const sourceItemPlantId = toId(sourceItem?.plantId);
    if (sourceItemPlantId) return sourceItemPlantId;

    // Fallback for legacy data before item-level plantId existed.
    const sourceRequest = getSourcePurchaseRequest(order, item);
    return toId(sourceRequest?.plantId) || toId(order?.plantId);
};

const itemMatchesReportFilters = (
    item: any,
    filters: MaterialReportFilters,
    materialIds?: Set<string>,
    fallbackSupplierId?: string,
    order?: any
) => {
    const itemMaterialId = toId(item.materialId);
    if (materialIds && (!itemMaterialId || !materialIds.has(itemMaterialId))) return false;

    if (filters.plantId && getReportOrderItemPlantId(order, item) !== filters.plantId) return false;

    if (filters.supplierId) {
        const supplierId = toId(item.supplierId) || fallbackSupplierId;
        if (supplierId !== filters.supplierId) return false;
    }

    return true;
};

const getReportOrderItems = (order: any, filters: MaterialReportFilters, materialIds?: Set<string>) =>
    ((order.items ?? []) as any[]).filter((item) =>
        itemMatchesReportFilters(item, filters, materialIds, toId(order.supplierId), order)
    );

const sumItemsAmount = (items: any[], key: 'totalWithVat' | 'totalPrice' = 'totalWithVat') =>
    items.reduce((sum, item) => sum + Number(item[key] ?? item.totalPrice ?? 0), 0);

const getItemSupplierName = (item: any) =>
    item.supplierName || (item.supplierId && typeof item.supplierId === 'object' ? item.supplierId.name : undefined);

const getOrderSupplierInfo = (order: any, items: any[] = order.items ?? []) => {
    const orderSupplierId = toId(order.supplierId);
    const orderSupplierName = order.supplierName || order.supplierId?.name;

    if (orderSupplierId || orderSupplierName) {
        return {
            supplierId: orderSupplierId,
            supplierName: orderSupplierName || 'Chua gan nha cung cap',
        };
    }

    const itemSuppliers = new Map<string, { supplierId?: string; supplierName: string }>();

    items.forEach((item) => {
        const supplierId = toId(item.supplierId);
        const supplierName = getItemSupplierName(item);
        const key = supplierId || supplierName;
        if (!key || !supplierName) return;
        itemSuppliers.set(key, { supplierId, supplierName });
    });

    const suppliers = Array.from(itemSuppliers.values());
    if (suppliers.length === 1) return suppliers[0];
    if (suppliers.length > 1) {
        return {
            supplierId: undefined,
            supplierName: `Nhieu nha cung cap (${suppliers.length})`,
        };
    }

    return {
        supplierId: undefined,
        supplierName: 'Chua gan nha cung cap',
    };
};

const buildReturnReportMatch = (filters: MaterialReportFilters, purchaseOrderIds?: any[]) => {
    const match: Record<string, any> = { isDeleted: { $ne: true } };

    if (purchaseOrderIds) {
        match.purchaseOrderId = { $in: purchaseOrderIds };
    }

    if (filters.startDate || filters.endDate) {
        match.returnedAt = {};
        if (filters.startDate) match.returnedAt.$gte = filters.startDate;
        if (filters.endDate) match.returnedAt.$lte = filters.endDate;
    }

    if (filters.supplierId) {
        match.$or = [
            { supplierId: new mongoose.Types.ObjectId(filters.supplierId) },
            { 'items.supplierId': new mongoose.Types.ObjectId(filters.supplierId) },
        ];
    }

    return match;
};

const returnItemMatchesPurchaseItem = (returnItem: any, purchaseItem: any) => {
    const returnMaterialId = toId(returnItem.materialId);
    const purchaseMaterialId = toId(purchaseItem.materialId);
    if (returnMaterialId && purchaseMaterialId) return returnMaterialId === purchaseMaterialId;
    return Boolean(
        returnItem.materialName && purchaseItem.materialName && returnItem.materialName === purchaseItem.materialName
    );
};

const returnItemMatchesReportScope = (
    returnItem: any,
    filters: MaterialReportFilters,
    materialIds: Set<string> | undefined,
    reportItems: any[],
    fallbackSupplierId?: string
) => {
    const itemMaterialId = toId(returnItem.materialId);
    if (materialIds && (!itemMaterialId || !materialIds.has(itemMaterialId))) return false;

    if (filters.supplierId) {
        const supplierId = toId(returnItem.supplierId) || fallbackSupplierId;
        if (supplierId !== filters.supplierId) return false;
    }

    return reportItems.some((purchaseItem) => returnItemMatchesPurchaseItem(returnItem, purchaseItem));
};

const getRefundByPurchaseOrder = async (
    ReturnRecord: any,
    filters: MaterialReportFilters,
    purchaseOrders: any[],
    materialIds?: Set<string>
): Promise<Map<string, number>> => {
    const purchaseOrderIds = purchaseOrders.map((order: any) => order._id);
    if (!purchaseOrderIds.length) return new Map<string, number>();

    const reportItemsByOrder = new Map(
        purchaseOrders.map((order: any) => [String(order._id), getReportOrderItems(order, filters, materialIds)])
    );
    const rows = await ReturnRecord.find(buildReturnReportMatch(filters, purchaseOrderIds)).lean();
    const refundByOrder = new Map<string, number>();

    rows.forEach((record: any) => {
        const orderId = String(record.purchaseOrderId);
        const reportItems = reportItemsByOrder.get(orderId) ?? [];
        const total = (record.items ?? []).reduce((sum: number, item: any) => {
            if (!returnItemMatchesReportScope(item, filters, materialIds, reportItems, toId(record.supplierId)))
                return sum;
            return sum + Number(item.refundWithVat ?? 0);
        }, 0);
        if (total > 0) refundByOrder.set(orderId, Number(((refundByOrder.get(orderId) ?? 0) + total).toFixed(2)));
    });

    return refundByOrder;
};

const getRefundBySupplier = async (
    ReturnRecord: any,
    filters: MaterialReportFilters,
    purchaseOrders: any[],
    materialIds?: Set<string>
): Promise<Map<string, number>> => {
    const purchaseOrderIds = purchaseOrders.map((order: any) => order._id);
    if (!purchaseOrderIds.length) return new Map<string, number>();

    const reportItemsByOrder = new Map(
        purchaseOrders.map((order: any) => [String(order._id), getReportOrderItems(order, filters, materialIds)])
    );
    const rows = await ReturnRecord.find(buildReturnReportMatch(filters, purchaseOrderIds)).lean();
    const refundBySupplier = new Map<string, number>();

    rows.forEach((record: any) => {
        const reportItems = reportItemsByOrder.get(String(record.purchaseOrderId)) ?? [];
        (record.items ?? []).forEach((item: any) => {
            if (!returnItemMatchesReportScope(item, filters, materialIds, reportItems, toId(record.supplierId))) return;
            const supplierId = toId(item.supplierId) || toId(record.supplierId);
            if (!supplierId) return;
            refundBySupplier.set(
                supplierId,
                Number(((refundBySupplier.get(supplierId) ?? 0) + Number(item.refundWithVat ?? 0)).toFixed(2))
            );
        });
    });

    return refundBySupplier;
};

const getPurchaseOrdersForReport = async (filters: MaterialReportFilters, materialIds?: Set<string>) => {
    const orders = await PurchaseOrder.find({ isDeleted: { $ne: true } })
        .populate('purchaseRequestIds')
        .populate('supplierId')
        .populate('items.supplierId', 'name');

    return orders.filter((order: any) => {
        if (filters.status && order.status !== filters.status) return false;

        const effectiveDate = getOrderEffectiveDate(order);
        if (!isDateInRange(effectiveDate, filters)) return false;

        const orderSupplierId = toId(order.supplierId);
        if (filters.supplierId && orderSupplierId !== filters.supplierId) {
            const hasItemSupplier = (order.items ?? []).some(
                (item: any) => toId(item.supplierId) === filters.supplierId
            );
            if (!hasItemSupplier) return false;
        }

        return getReportOrderItems(order, filters, materialIds).length > 0;
    });
};

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
    const inventoryStocks = await (InventoryStock as any)
        .find({
            materialId: req.params.id,
            isDeleted: { $ne: true },
            ...stockPlantFilter,
        })
        .populate('materialId')
        .populate('plantId');

    const totalCurrentStock = inventoryStocks.reduce(
        (sum: number, stock: any) => sum + Number(stock.currentStock ?? 0),
        0
    );

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
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);

    const materialCountFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        isActive: { $ne: false },
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.materialId ? { _id: filters.materialId } : {}),
    };

    const requestFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        status: 'pending',
    };
    if (filters.startDate || filters.endDate) {
        requestFilter.createdAt = {};
        if (filters.startDate) requestFilter.createdAt.$gte = filters.startDate;
        if (filters.endDate) requestFilter.createdAt.$lte = filters.endDate;
    }
    const pendingRequestFilter: Record<string, any> = { ...requestFilter };
    const materialObjectIds = materialIds
        ? Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id))
        : undefined;
    if (filters.plantId) {
        const plantObjectId = new mongoose.Types.ObjectId(filters.plantId);
        const itemElemMatch: Record<string, any> = { plantId: plantObjectId };
        if (materialObjectIds) itemElemMatch.materialId = { $in: materialObjectIds };

        pendingRequestFilter.$or = [
            { items: { $elemMatch: itemElemMatch } },
            {
                plantId: plantObjectId,
                'items.plantId': { $exists: false },
                ...(materialObjectIds ? { 'items.materialId': { $in: materialObjectIds } } : {}),
            },
        ];
    } else if (materialObjectIds) {
        pendingRequestFilter['items.materialId'] = { $in: materialObjectIds };
    }

    const [totalMaterials, pendingRequestCount, lowStockMaterials, purchaseOrders, ReturnRecord, DistributionRecord] =
        await Promise.all([
            Material.countDocuments(materialCountFilter),
            PurchaseRequest.countDocuments(pendingRequestFilter),
            getLowStockMaterialsData(req),
            getPurchaseOrdersForReport(filters, materialIds),
            import('@/models/ReturnRecord').then((m) => m.default),
            import('@/models/DistributionRecord').then((m) => m.default),
        ]);

    const refundMap = await getRefundByPurchaseOrder(ReturnRecord, filters, purchaseOrders, materialIds);

    const distributionMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        status: { $in: ['distributed', 'confirmed'] },
        ...(filters.plantId ? { toPlantId: new mongoose.Types.ObjectId(filters.plantId) } : {}),
    };
    if (filters.startDate || filters.endDate) {
        distributionMatch.createdAt = {};
        if (filters.startDate) distributionMatch.createdAt.$gte = filters.startDate;
        if (filters.endDate) distributionMatch.createdAt.$lte = filters.endDate;
    }
    if (materialIds) {
        distributionMatch['items.materialId'] = {
            $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)),
        };
    }

    const distributionAgg = await DistributionRecord.aggregate([
        { $match: distributionMatch },
        { $unwind: '$items' },
        ...(materialIds
            ? [
                  {
                      $match: {
                          'items.materialId': {
                              $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)),
                          },
                      },
                  },
              ]
            : []),
        {
            $group: {
                _id: null,
                totalWithVat: { $sum: { $ifNull: ['$items.totalWithVat', 0] } },
                count: { $addToSet: '$_id' },
            },
        },
    ]);

    const totalPurchaseCost = purchaseOrders.reduce((sum, order: any) => {
        const items = getReportOrderItems(order, filters, materialIds);
        return sum + sumItemsAmount(items, 'totalWithVat');
    }, 0);
    const totalRefund = Array.from(refundMap.values()).reduce((sum, value) => sum + value, 0);
    const totalDistributionCost = Number(distributionAgg[0]?.totalWithVat ?? 0);
    const distributionRecordCount = Number(distributionAgg[0]?.count?.length ?? 0);
    const totalEstimated = purchaseOrders.reduce((sum, order: any) => {
        const items = getReportOrderItems(order, filters, materialIds);
        return (
            sum +
            items.reduce((itemSum, item) => {
                const qty = Number(item.quantityRequested ?? item.quantityOrdered ?? 0);
                const price = Number(item.unitPrice ?? 0);
                const vatRate = Number(item.vatRate ?? 0);
                return itemSum + Number((qty * price * (1 + vatRate / 100)).toFixed(2));
            }, 0)
        );
    }, 0);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                totalMaterials,
                totalMonthlyCost: Number(totalPurchaseCost.toFixed(2)),
                totalPurchaseCost: Number(totalPurchaseCost.toFixed(2)),
                totalDistributionCost: Number(totalDistributionCost.toFixed(2)),
                totalRefund: Number(totalRefund.toFixed(2)),
                totalNetPurchaseCost: Number(Math.max(0, totalPurchaseCost - totalRefund).toFixed(2)),
                totalPriceVariance: Number((Math.max(0, totalPurchaseCost - totalRefund) - totalEstimated).toFixed(2)),
                distributionRecordCount,
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
    const filters = buildReportFilters({
        ...req.query,
        groupBy: req.query.period === 'quarter' ? 'quarter' : req.query.groupBy,
    });
    const materialIds = await getMaterialIdsForReport(filters);

    const [purchaseOrders, ReturnRecord] = await Promise.all([
        getPurchaseOrdersForReport(filters, materialIds),
        import('@/models/ReturnRecord').then((m) => m.default),
    ]);

    // Map poId → totalRefundWithVat
    const refundMap = await getRefundByPurchaseOrder(ReturnRecord, filters, purchaseOrders, materialIds);

    // Tách OPEX/CAPEX theo Material.costType để chart mua không bị "độn" tiền mua máy/CCDC.
    const capexTypeSet = new Set<string>(CAPEX_COST_TYPES);
    const costTypeDocs = await Material.find({ isDeleted: { $ne: true } }).select('_id costType').lean();
    const costTypeMap = new Map<string, string | undefined>(
        costTypeDocs.map((m: any) => [String(m._id), m.costType || undefined])
    );

    const groupedData = purchaseOrders.reduce(
        (result: Record<string, { total: number; opex: number; capex: number }>, order: any) => {
            const orderDate = getOrderEffectiveDate(order);
            const key = getPeriodLabel(orderDate, filters.groupBy);
            const items = getReportOrderItems(order, filters, materialIds);

            const itemsTotal = sumItemsAmount(items, 'totalWithVat');
            const capexTotal = items.reduce((sum: number, item: any) => {
                const ct = costTypeMap.get(toId(item.materialId) ?? '');
                if (!ct || !capexTypeSet.has(ct)) return sum;
                return sum + Number(item.totalWithVat ?? item.totalPrice ?? 0);
            }, 0);
            const refund = refundMap.get(String(order._id)) ?? 0;
            const net = Math.max(0, itemsTotal - refund);
            // Hoàn trả trừ theo tỷ lệ vào từng nhóm để opex + capex luôn = net.
            const refundRatio = itemsTotal > 0 ? net / itemsTotal : 0;
            const capexNet = capexTotal * refundRatio;
            const opexNet = net - capexNet;

            const row = result[key] ?? { total: 0, opex: 0, capex: 0 };
            row.total = Number((row.total + net).toFixed(2));
            row.opex = Number((row.opex + opexNet).toFixed(2));
            row.capex = Number((row.capex + capexNet).toFixed(2));
            result[key] = row;
            return result;
        },
        {}
    );

    const data = Object.entries(groupedData)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, row]) => ({
            period: label,
            totalAmount: row.total,
            opexAmount: row.opex,
            capexAmount: row.capex,
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
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);
    const [purchaseOrders, ReturnRecord] = await Promise.all([
        getPurchaseOrdersForReport(filters, materialIds),
        import('@/models/ReturnRecord').then((m) => m.default),
    ]);

    // Refund theo supplierId ở item level (chính xác khi PO có nhiều NCC)
    const refundBySupplier = await getRefundBySupplier(ReturnRecord, filters, purchaseOrders, materialIds);

    const groupedData: Record<
        string,
        { supplierId?: string; supplierName: string; totalAmount: number; orderCount: Set<string> }
    > = {};

    purchaseOrders.forEach((order: any) => {
        getReportOrderItems(order, filters, materialIds).forEach((item: any) => {
            const supplierId = toId(item.supplierId) || toId(order.supplierId);
            const supplierName =
                getItemSupplierName(item) || order.supplierName || order.supplierId?.name || 'Chua gan nha cung cap';
            const key = supplierId || supplierName;
            if (!groupedData[key]) {
                groupedData[key] = { supplierId, supplierName, totalAmount: 0, orderCount: new Set() };
            }
            groupedData[key].totalAmount += item.totalWithVat ?? item.totalPrice ?? 0;
            groupedData[key].orderCount.add(String(order._id));
        });
    });

    const data = Object.values(groupedData)
        .map(({ supplierId, supplierName, totalAmount, orderCount }) => ({
            supplierId,
            supplierName,
            totalAmount: Number(
                Math.max(0, totalAmount - (supplierId ? (refundBySupplier.get(supplierId) ?? 0) : 0)).toFixed(2)
            ),
            orderCount: orderCount.size,
        }))
        .sort((a, b) => b.totalAmount - a.totalAmount);

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
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);
    const [purchaseOrders, ReturnRecord] = await Promise.all([
        getPurchaseOrdersForReport(filters, materialIds),
        import('@/models/ReturnRecord').then((m) => m.default),
    ]);

    const refundMap = await getRefundByPurchaseOrder(ReturnRecord, filters, purchaseOrders, materialIds);

    const data = purchaseOrders.map((order: any) => {
        const items = getReportOrderItems(order, filters, materialIds);
        const supplierInfo = getOrderSupplierInfo(order, items);
        const estimatedTotal = items.reduce((sum: number, item: any) => {
            const qty = Number(item.quantityRequested ?? 0);
            const price = Number(item.unitPrice ?? 0);
            const vatRate = Number(item.vatRate ?? 0);
            const base = Number((qty * price).toFixed(2));
            return sum + Number((base * (1 + vatRate / 100)).toFixed(2));
        }, 0);
        const actualTotal = Number(sumItemsAmount(items, 'totalWithVat').toFixed(2));
        const refundTotal = refundMap.get(String(order._id)) ?? 0;
        const netActual = Number(Math.max(0, actualTotal - refundTotal).toFixed(2));

        return {
            orderId: String(order._id),
            orderCode: order.orderCode,
            supplierId: supplierInfo.supplierId,
            supplierName: supplierInfo.supplierName,
            requestCodes: (order.purchaseRequestIds ?? []).map((r: any) => r.requestCode),
            estimatedTotal: Number(estimatedTotal.toFixed(2)),
            actualTotal,
            refundTotal: Number(refundTotal.toFixed(2)),
            netActual,
            difference: Number((netActual - estimatedTotal).toFixed(2)),
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

export const getTopMaterials = async (req: Request, res: Response, next: NextFunction) => {
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const txFilter: Record<string, any> = { isDeleted: { $ne: true }, type: 'export' };
    if (filters.plantId) txFilter.plantId = new mongoose.Types.ObjectId(filters.plantId);
    if (materialIds) {
        txFilter.materialId = { $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)) };
    }
    if (filters.startDate || filters.endDate) {
        txFilter.createdAt = {};
        if (filters.startDate) txFilter.createdAt.$gte = filters.startDate;
        if (filters.endDate) txFilter.createdAt.$lte = filters.endDate;
    }

    const StockTransaction = (await import('@/models/StockTransaction')).default;

    const agg = await StockTransaction.aggregate([
        { $match: txFilter },
        {
            $group: {
                _id: '$materialId',
                totalQuantityOut: { $sum: { $abs: '$quantity' } },
            },
        },
        { $sort: { totalQuantityOut: -1 } },
        { $limit: limit },
        {
            $lookup: {
                from: 'materials',
                localField: '_id',
                foreignField: '_id',
                as: 'material',
            },
        },
        { $unwind: { path: '$material', preserveNullAndEmptyArrays: false } },
        {
            $lookup: {
                from: 'inventorystocks',
                let: { mid: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: { $eq: ['$materialId', '$$mid'] },
                            isDeleted: { $ne: true },
                            ...(filters.plantId ? { plantId: new mongoose.Types.ObjectId(filters.plantId) } : {}),
                        },
                    },
                    { $group: { _id: null, total: { $sum: '$currentStock' } } },
                ],
                as: 'stockAgg',
            },
        },
    ]);

    const data = agg.map((row: any) => ({
        materialId: String(row._id),
        materialCode: row.material?.code || '',
        materialName: row.material?.name || '',
        category: row.material?.category || '',
        unit: row.material?.unit || '',
        totalQuantityOut: row.totalQuantityOut,
        currentStock: row.stockAgg?.[0]?.total ?? 0,
        minStockLevel: row.material?.minStockLevel ?? 0,
    }));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Lay top vat tu tieu thu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportMaterialCatalogExcel = async (req: Request, res: Response, next: NextFunction) => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Danh mục vật tư');

    ws.columns = [
        { header: 'Mã vật tư', key: 'code', width: 18 },
        { header: 'Tên vật tư', key: 'name', width: 35 },
        { header: 'Nhóm / Category', key: 'category', width: 22 },
        { header: 'Đơn vị tính', key: 'unit', width: 14 },
        { header: 'Ngưỡng tối thiểu', key: 'minStockLevel', width: 18 },
        { header: 'Mô tả', key: 'description', width: 40 },
        { header: 'Trạng thái', key: 'isActive', width: 14 },
    ];

    // Style header row
    ws.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A5C' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    ws.getRow(1).height = 22;

    const materials = await materialRepository.findMany({ isDeleted: { $ne: true } }, { sort: 'name', limit: 10000 });

    materials.forEach((m: any) => {
        ws.addRow({
            code: m.code || '',
            name: m.name,
            category: m.category || '',
            unit: m.unit,
            minStockLevel: m.minStockLevel ?? 0,
            description: m.description || '',
            isActive: m.isActive !== false ? 'Hoạt động' : 'Ngừng',
        });
    });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="danh-muc-vat-tu.xlsx"');
    return res.send(Buffer.from(buffer));
};

export const downloadMaterialImportTemplate = async (req: Request, res: Response, next: NextFunction) => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Mẫu nhập vật tư');

    ws.columns = [
        { header: 'Mã vật tư (*)', key: 'code', width: 18 },
        { header: 'Tên vật tư (*)', key: 'name', width: 35 },
        { header: 'Nhóm / Category', key: 'category', width: 22 },
        { header: 'Đơn vị tính (*)', key: 'unit', width: 14 },
        { header: 'Ngưỡng tối thiểu', key: 'minStockLevel', width: 18 },
        { header: 'Mô tả', key: 'description', width: 40 },
    ];

    ws.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A5C' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    ws.getRow(1).height = 22;

    // Sample rows
    [
        { code: 'VT001', name: 'Chỉ may trắng', category: 'Kim chỉ', unit: 'Cuộn', minStockLevel: 50, description: '' },
        {
            code: 'VT002',
            name: 'Dầu máy may',
            category: 'Dầu nhớt',
            unit: 'Lít',
            minStockLevel: 10,
            description: 'Dầu bôi trơn',
        },
    ].forEach((row) => ws.addRow(row));

    // Note sheet
    const noteWs = wb.addWorksheet('Hướng dẫn');
    noteWs.getColumn(1).width = 80;
    [
        ['HƯỚNG DẪN NHẬP LIỆU'],
        [''],
        ['(*) = Bắt buộc'],
        ['- Mã vật tư: Duy nhất trong hệ thống, không trùng lặp'],
        ['- Tên vật tư: Bắt buộc'],
        ['- Đơn vị tính: Bắt buộc (VD: Cái, Cuộn, Lít, Kg, Hộp...)'],
        ['- Ngưỡng tối thiểu: Số nguyên >= 0, mặc định 0'],
        ['- Nếu mã đã tồn tại: hệ thống sẽ CẬP NHẬT thông tin vật tư đó'],
        ['- Nếu mã chưa tồn tại: hệ thống sẽ TẠO MỚI'],
    ].forEach(([text]) => {
        const row = noteWs.addRow([text]);
        if (text?.startsWith('HƯỚNG')) row.getCell(1).font = { bold: true, size: 13 };
    });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="mau-nhap-vat-tu.xlsx"');
    return res.send(Buffer.from(buffer));
};

export const importMaterialExcel = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) throw new BadRequestError('Vui lòng chọn file Excel');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(req.file.buffer) as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestError('File Excel không hợp lệ');

    type RowResult = {
        row: number;
        code: string;
        name: string;
        action: 'created' | 'updated' | 'error';
        reason?: string;
    };
    const results: RowResult[] = [];
    const dataRows: Array<{
        rowNum: number;
        code: string;
        name: string;
        category: string;
        unit: string;
        minStockLevel: number;
        description: string;
    }> = [];

    ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const code = String(row.getCell(1).value ?? '').trim();
        const name = String(row.getCell(2).value ?? '').trim();
        const category = String(row.getCell(3).value ?? '').trim();
        const unit = String(row.getCell(4).value ?? '').trim();
        const minStockLevel = Number(row.getCell(5).value ?? 0);
        const description = String(row.getCell(6).value ?? '').trim();
        if (!code && !name) return;
        dataRows.push({ rowNum, code, name, category, unit, minStockLevel, description });
    });

    for (const { rowNum, code, name, category, unit, minStockLevel, description } of dataRows) {
        if (!name) {
            results.push({ row: rowNum, code, name, action: 'error', reason: 'Tên vật tư không được để trống' });
            continue;
        }
        if (!unit) {
            results.push({ row: rowNum, code, name, action: 'error', reason: 'Đơn vị tính không được để trống' });
            continue;
        }
        if (isNaN(minStockLevel) || minStockLevel < 0) {
            results.push({ row: rowNum, code, name, action: 'error', reason: 'Ngưỡng tối thiểu phải >= 0' });
            continue;
        }

        try {
            const existing = code
                ? await Material.findOne({ code, isDeleted: { $ne: true } })
                      .select('_id')
                      .lean()
                : null;

            if (existing) {
                await materialRepository.updateById(String(existing._id), {
                    name,
                    category: category || undefined,
                    unit,
                    minStockLevel: minStockLevel || 0,
                    description: description || undefined,
                    updatedBy: req.userId,
                });
                results.push({ row: rowNum, code, name, action: 'updated' });
            } else {
                // Check duplicate name if no code
                if (!code) {
                    const dupName = await Material.findOne({ name, isDeleted: { $ne: true } })
                        .select('_id')
                        .lean();
                    if (dupName) {
                        results.push({
                            row: rowNum,
                            code,
                            name,
                            action: 'error',
                            reason: 'Tên vật tư đã tồn tại (không có mã để phân biệt)',
                        });
                        continue;
                    }
                }
                await materialRepository.create({
                    code: code || undefined,
                    name,
                    category: category || undefined,
                    unit,
                    minStockLevel: minStockLevel || 0,
                    description: description || undefined,
                    isActive: true,
                    createdBy: req.userId,
                    updatedBy: req.userId,
                });
                results.push({ row: rowNum, code, name, action: 'created' });
            }
        } catch (err: any) {
            results.push({ row: rowNum, code, name, action: 'error', reason: err?.message || 'Lỗi không xác định' });
        }
    }

    const created = results.filter((r) => r.action === 'created').length;
    const updated = results.filter((r) => r.action === 'updated').length;
    const errors = results.filter((r) => r.action === 'error').length;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { created, updated, errors, total: dataRows.length, rows: results },
            message: `Import hoàn tất: ${created} tạo mới, ${updated} cập nhật, ${errors} lỗi`,
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// ─── MATERIAL IMPORT HELPERS ─────────────────────────────────────────────────

type MaterialImportRow = {
    rowNumber: number;
    isValid: boolean;
    values: { code: string; name: string; category: string; unit: string; minStockLevel: number; description: string };
    errors: string[];
    action?: 'create' | 'update';
    payload?: Record<string, any>;
};

const parseMaterialImportRows = async (fileBuffer: Buffer): Promise<MaterialImportRow[]> => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fileBuffer as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestError('File Excel không hợp lệ');

    const rows: MaterialImportRow[] = [];

    ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const code = String(row.getCell(1).value ?? '').trim();
        const name = String(row.getCell(2).value ?? '').trim();
        const category = String(row.getCell(3).value ?? '').trim();
        const unit = String(row.getCell(4).value ?? '').trim();
        const minStockLevel = Number(row.getCell(5).value ?? 0);
        const description = String(row.getCell(6).value ?? '').trim();
        if (!code && !name) return;

        const errors: string[] = [];
        if (!name) errors.push('Tên vật tư không được để trống');
        if (!unit) errors.push('Đơn vị tính không được để trống');
        if (isNaN(minStockLevel) || minStockLevel < 0) errors.push('Ngưỡng tối thiểu phải >= 0');

        rows.push({
            rowNumber: rowNum,
            isValid: errors.length === 0,
            values: {
                code,
                name,
                category,
                unit,
                minStockLevel: isNaN(minStockLevel) ? 0 : minStockLevel,
                description,
            },
            errors,
            payload:
                errors.length === 0
                    ? {
                          code: code || undefined,
                          name,
                          category: category || undefined,
                          unit,
                          minStockLevel: minStockLevel || 0,
                          description: description || undefined,
                      }
                    : undefined,
        });
    });

    if (!rows.length) throw new BadRequestError('File không có dòng dữ liệu');

    // Kiểm tra trùng mã trong file
    const codeCount = new Map<string, number>();
    rows.forEach((r) => {
        if (r.values.code) codeCount.set(r.values.code, (codeCount.get(r.values.code) ?? 0) + 1);
    });
    rows.forEach((r) => {
        if (r.values.code && (codeCount.get(r.values.code) ?? 0) > 1) {
            r.errors.push('Mã vật tư bị trùng trong file');
            r.isValid = false;
            r.payload = undefined;
        }
    });

    // Kiểm tra mã đã tồn tại trong DB → action = update
    const codes = rows.filter((r) => r.payload?.code).map((r) => r.payload!.code);
    const existingMap = new Map<string, string>();
    if (codes.length) {
        const existing = await Material.find({ code: { $in: codes }, isDeleted: { $ne: true } })
            .select('_id code')
            .lean();
        existing.forEach((m: any) => existingMap.set(m.code, String(m._id)));
    }

    rows.forEach((r) => {
        if (!r.payload) return;
        if (r.payload.code && existingMap.has(r.payload.code)) {
            r.action = 'update';
            r.payload._existingId = existingMap.get(r.payload.code);
        } else {
            r.action = 'create';
        }
    });

    // Kiểm tra trùng tên trong DB cho rows không có mã (sẽ tạo mới)
    const namesToCheck = rows
        .filter((r) => r.action === 'create' && !r.payload?.code && r.payload?.name)
        .map((r) => r.payload!.name);
    if (namesToCheck.length) {
        const dupNames = await Material.find({ name: { $in: namesToCheck }, isDeleted: { $ne: true } })
            .select('name')
            .lean();
        const dupNameSet = new Set(dupNames.map((m: any) => m.name));
        rows.forEach((r) => {
            if (r.action === 'create' && !r.payload?.code && r.payload?.name && dupNameSet.has(r.payload.name)) {
                r.errors.push('Tên vật tư đã tồn tại (không có mã để phân biệt)');
                r.isValid = false;
                r.action = undefined;
                r.payload = undefined;
            }
        });
    }

    // Kiểm tra trùng tên trong chính file (rows không có mã)
    const nameInFileCount = new Map<string, number>();
    rows.forEach((r) => {
        if (!r.values.code && r.values.name)
            nameInFileCount.set(r.values.name, (nameInFileCount.get(r.values.name) ?? 0) + 1);
    });
    rows.forEach((r) => {
        if (!r.values.code && r.values.name && (nameInFileCount.get(r.values.name) ?? 0) > 1) {
            r.errors.push('Tên vật tư bị trùng trong file (không có mã)');
            r.isValid = false;
            r.action = undefined;
            r.payload = undefined;
        }
    });

    return rows;
};

export const previewMaterialImport = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) throw new BadRequestError('Vui lòng chọn file Excel');

    const rows = await parseMaterialImportRows(req.file.buffer);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                summary: {
                    totalRows: rows.length,
                    validRows: rows.filter((r) => r.isValid).length,
                    invalidRows: rows.filter((r) => !r.isValid).length,
                    toCreate: rows.filter((r) => r.action === 'create').length,
                    toUpdate: rows.filter((r) => r.action === 'update').length,
                },
                rows: rows.map(({ payload, ...r }) => r),
            },
            message: 'Xem trước import vật tư thành công',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const confirmMaterialImport = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) throw new BadRequestError('Vui lòng chọn file Excel');

    const rows = await parseMaterialImportRows(req.file.buffer);
    let created = 0,
        updated = 0,
        errors = 0;

    for (const row of rows) {
        if (!row.payload || !row.isValid) {
            errors++;
            continue;
        }
        try {
            if (row.action === 'update' && row.payload._existingId) {
                const { _existingId, ...data } = row.payload;
                await materialRepository.updateById(_existingId, { ...data, updatedBy: req.userId });
                updated++;
            } else {
                await materialRepository.create({
                    ...row.payload,
                    isActive: true,
                    createdBy: req.userId,
                    updatedBy: req.userId,
                });
                created++;
            }
        } catch {
            errors++;
        }
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { created, updated, errors, total: rows.length },
            message: `Import hoàn tất: ${created} tạo mới, ${updated} cập nhật, ${errors} lỗi`,
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getDistributionCostReport = async (req: Request, res: Response, next: NextFunction) => {
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);

    const matchStage: Record<string, any> = {
        isDeleted: { $ne: true },
        status: { $in: ['distributed', 'confirmed'] },
    };
    if (filters.plantId) matchStage.toPlantId = new mongoose.Types.ObjectId(filters.plantId);
    if (filters.startDate || filters.endDate) {
        // dùng createdAt vì distributedAt có thể null trên một số record cũ
        matchStage.createdAt = {};
        if (filters.startDate) matchStage.createdAt.$gte = filters.startDate;
        if (filters.endDate) matchStage.createdAt.$lte = filters.endDate;
    }
    if (materialIds) {
        matchStage['items.materialId'] = { $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const DistributionRecord = (await import('@/models/DistributionRecord')).default;

    const byPlant = await DistributionRecord.aggregate([
        { $match: matchStage },
        { $unwind: '$items' },
        ...(materialIds
            ? [
                  {
                      $match: {
                          'items.materialId': {
                              $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)),
                          },
                      },
                  },
              ]
            : []),
        {
            $group: {
                _id: '$toPlantId',
                totalWithVat: { $sum: { $ifNull: ['$items.totalWithVat', 0] } },
                totalAmount: { $sum: { $ifNull: ['$items.totalPrice', 0] } },
                count: { $addToSet: '$_id' },
            },
        },
        {
            $lookup: {
                from: 'plants',
                localField: '_id',
                foreignField: '_id',
                as: 'plant',
            },
        },
        { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
        { $sort: { totalWithVat: -1 } },
    ]);

    const byPeriod = await DistributionRecord.aggregate([
        { $match: matchStage },
        { $unwind: '$items' },
        ...(materialIds
            ? [
                  {
                      $match: {
                          'items.materialId': {
                              $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)),
                          },
                      },
                  },
              ]
            : []),
        {
            $group: {
                _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' },
                    docId: '$_id',
                    ...(filters.plantId ? { plantId: '$toPlantId' } : {}),
                },
                totalWithVat: { $sum: { $ifNull: ['$items.totalWithVat', 0] } },
            },
        },
        {
            $group: {
                _id: {
                    year: '$_id.year',
                    month: '$_id.month',
                    ...(filters.plantId ? { plantId: '$_id.plantId' } : {}),
                },
                totalWithVat: { $sum: '$totalWithVat' },
                count: { $sum: 1 },
            },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                byPlant: byPlant.map((r: any) => ({
                    plantId: String(r._id),
                    plantName: r.plant?.name || 'Không xác định',
                    totalWithVat: Number(r.totalWithVat.toFixed(2)),
                    totalAmount: Number(r.totalAmount.toFixed(2)),
                    count: r.count.length,
                })),
                byPeriod: byPeriod.map((r: any) => ({
                    period: `${r._id.year}-${String(r._id.month).padStart(2, '0')}`,
                    totalWithVat: Number(r.totalWithVat.toFixed(2)),
                    count: r.count,
                })),
            },
            message: 'Lay bao cao chi phi cap phat thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

type MaterialCostFlowPlantRow = {
    plantId?: string;
    plantName: string;
    purchaseCost: number;
    distributionCost: number;
    totalCost: number;
    purchaseOrderCount: number;
    distributionCount: number;
    purchaseItemCount: number;
    distributionItemCount: number;
    canPurchase: boolean;
    purchaseOrderIds: string[];
    distributionIds: string[];
};

const parseProcurementPlantIds = () =>
    new Set(
        [process.env.PROCUREMENT_PLANT_IDS, process.env.MAIN_PLANT_ID]
            .filter(Boolean)
            .flatMap((value) => String(value).split(','))
            .map((value) => value.trim())
            .filter(Boolean)
    );

const getCostFlowPlantKey = (plantId?: string, plantName?: string) => plantId || `name:${plantName || 'unknown'}`;

const getCostFlowPlantRow = (
    rows: Map<string, MaterialCostFlowPlantRow & { purchaseOrderIdSet: Set<string>; distributionIdSet: Set<string> }>,
    procurementPlantIds: Set<string>,
    plantId?: string,
    plantName = 'Chưa xác định'
) => {
    const key = getCostFlowPlantKey(plantId, plantName);
    const existing = rows.get(key);
    if (existing) {
        if (existing.plantName === 'Chưa xác định' && plantName !== 'Chưa xác định') existing.plantName = plantName;
        return existing;
    }

    const row: MaterialCostFlowPlantRow & { purchaseOrderIdSet: Set<string>; distributionIdSet: Set<string> } = {
        plantId,
        plantName,
        purchaseCost: 0,
        distributionCost: 0,
        totalCost: 0,
        purchaseOrderCount: 0,
        distributionCount: 0,
        purchaseItemCount: 0,
        distributionItemCount: 0,
        canPurchase: Boolean(plantId && procurementPlantIds.has(plantId)),
        purchaseOrderIds: [],
        distributionIds: [],
        purchaseOrderIdSet: new Set<string>(),
        distributionIdSet: new Set<string>(),
    };
    rows.set(key, row);
    return row;
};

const getPurchaseItemPlantName = (order: any, item: any, plantNameById: Map<string, string>) => {
    const plantId = getReportOrderItemPlantId(order, item);
    const sourceItem = getSourcePurchaseRequestItem(order, item);

    return (
        item.plantName ||
        sourceItem?.plantName ||
        (plantId ? plantNameById.get(plantId) : undefined) ||
        'Chưa xác định'
    );
};

/**
 * Danh sách chi phí MUA vật tư phẳng theo từng dòng đơn hàng, gom theo cơ sở PHÁT SINH NHU CẦU
 * (giống logic chart "Tổng chi phí vật tư theo cơ sở": dùng totalWithVat + getReportOrderItemPlantId
 * + ngày hiệu lực đơn hàng). Báo cáo chi phí vận hành dùng hàm này để cộng phần "vật tư tự mua"
 * cho các cơ sở được phép tự đặt (vd Phú Sơn) — vốn không nằm trong luồng cấp phát từ CS1.
 */
export const getPurchaseCostEntriesByPlant = async (opts: {
    startDate?: Date;
    endDate?: Date;
}): Promise<
    Array<{ plantId: string; plantName: string; cost: number; effectiveDate: Date; orderId: string; materialId?: string }>
> => {
    const filters: MaterialReportFilters = {
        startDate: opts.startDate,
        endDate: opts.endDate,
        groupBy: 'month',
    };

    const [purchaseOrders, plants] = await Promise.all([
        getPurchaseOrdersForReport(filters),
        Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
    ]);
    const plantNameById = new Map(plants.map((plant: any) => [String(plant._id), plant.name || 'Chưa xác định']));

    const entries: Array<{
        plantId: string;
        plantName: string;
        cost: number;
        effectiveDate: Date;
        orderId: string;
        materialId?: string;
    }> = [];
    purchaseOrders.forEach((order: any) => {
        const orderId = String(order._id);
        const effectiveDate = getOrderEffectiveDate(order);
        getReportOrderItems(order, filters).forEach((item: any) => {
            const plantId = getReportOrderItemPlantId(order, item);
            if (!plantId) return;
            entries.push({
                plantId,
                plantName: getPurchaseItemPlantName(order, item, plantNameById),
                cost: Number(item.totalWithVat ?? item.totalPrice ?? 0),
                effectiveDate,
                orderId,
                materialId: item.materialId ? String(item.materialId) : undefined,
            });
        });
    });
    return entries;
};

export const getMaterialCostFlowByPlantReport = async (req: Request, res: Response, next: NextFunction) => {
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);
    const DistributionRecord = (await import('@/models/DistributionRecord')).default;

    const [purchaseOrders, plants] = await Promise.all([
        getPurchaseOrdersForReport(filters, materialIds),
        Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
    ]);

    const plantNameById = new Map(plants.map((plant: any) => [String(plant._id), plant.name || 'Chưa xác định']));
    const procurementPlantIds = parseProcurementPlantIds();
    const rows = new Map<
        string,
        MaterialCostFlowPlantRow & { purchaseOrderIdSet: Set<string>; distributionIdSet: Set<string> }
    >();

    purchaseOrders.forEach((order: any) => {
        const orderId = String(order._id);
        getReportOrderItems(order, filters, materialIds).forEach((item: any) => {
            const plantId = getReportOrderItemPlantId(order, item);
            const plantName = getPurchaseItemPlantName(order, item, plantNameById);
            const row = getCostFlowPlantRow(rows, procurementPlantIds, plantId, plantName);
            row.purchaseCost = Number(
                (row.purchaseCost + Number(item.totalWithVat ?? item.totalPrice ?? 0)).toFixed(2)
            );
            row.purchaseItemCount += 1;
            row.purchaseOrderIdSet.add(orderId);
        });
    });

    const distributionMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        status: { $in: ['distributed', 'confirmed'] },
    };
    if (filters.plantId) distributionMatch.toPlantId = new mongoose.Types.ObjectId(filters.plantId);
    if (filters.startDate || filters.endDate) {
        distributionMatch.createdAt = {};
        if (filters.startDate) distributionMatch.createdAt.$gte = filters.startDate;
        if (filters.endDate) distributionMatch.createdAt.$lte = filters.endDate;
    }
    if (materialIds) {
        distributionMatch['items.materialId'] = {
            $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)),
        };
    }

    const distributions = await DistributionRecord.find(distributionMatch).populate('toPlantId').lean();
    distributions.forEach((record: any) => {
        const plantId = record.toPlantId?._id ? String(record.toPlantId._id) : undefined;
        const plantName = record.toPlantId?.name || (plantId ? plantNameById.get(plantId) : undefined) || 'Chưa xác định';
        const row = getCostFlowPlantRow(rows, procurementPlantIds, plantId, plantName);
        const items = (record.items ?? []).filter((item: any) => {
            if (!materialIds) return true;
            const materialId = toId(item.materialId);
            return Boolean(materialId && materialIds.has(materialId));
        });
        const recordCost = items.reduce(
            (sum: number, item: any) => sum + Number(item.totalWithVat ?? item.totalPrice ?? 0),
            0
        );
        row.distributionCost = Number((row.distributionCost + recordCost).toFixed(2));
        row.distributionItemCount += items.length;
        row.distributionIdSet.add(String(record._id));
    });

    const data = Array.from(rows.values())
        .map((row) => ({
            plantId: row.plantId,
            plantName: row.plantName,
            purchaseCost: Number(row.purchaseCost.toFixed(2)),
            distributionCost: Number(row.distributionCost.toFixed(2)),
            totalCost: Number((row.purchaseCost + row.distributionCost).toFixed(2)),
            purchaseOrderCount: row.purchaseOrderIdSet.size,
            distributionCount: row.distributionIdSet.size,
            purchaseItemCount: row.purchaseItemCount,
            distributionItemCount: row.distributionItemCount,
            canPurchase: row.canPurchase,
            purchaseOrderIds: Array.from(row.purchaseOrderIdSet),
            distributionIds: Array.from(row.distributionIdSet),
        }))
        .filter((row) => row.totalCost > 0)
        .sort((a, b) => b.totalCost - a.totalCost);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Lay bao cao dong chi phi vat tu theo co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const exportMaterialReportExcelLegacy = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Material Report';

    const dateLabel =
        startDate && endDate
            ? `${new Date(startDate).toLocaleDateString('vi-VN')} - ${new Date(endDate).toLocaleDateString('vi-VN')}`
            : 'Tất cả';

    // ── Sheet 1: Tổng quan ──────────────────────────────────────────────────
    const summaryReq = { ...req, query: { ...req.query } } as Request;
    const summaryData = await (async () => {
        const now = new Date();
        const monthStart = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = endDate
            ? (() => {
                  const d = new Date(endDate);
                  d.setHours(23, 59, 59, 999);
                  return d;
              })()
            : new Date(now.getFullYear(), now.getMonth() + 1, 1);

        const [totalMaterials, pendingRequestCount, lowStockMaterials, purchaseOrders] = await Promise.all([
            Material.countDocuments({ isDeleted: { $ne: true }, isActive: { $ne: false } }),
            PurchaseRequest.countDocuments({
                isDeleted: { $ne: true },
                status: 'pending',
                ...(plantId ? { plantId } : {}),
            }),
            getLowStockMaterialsData(summaryReq),
            getPurchaseOrdersByPlant(plantId),
        ]);

        const totalCost = purchaseOrders
            .filter((o) => {
                const d = getOrderEffectiveDate(o);
                return d >= monthStart && d <= monthEnd;
            })
            .reduce((s, o: any) => s + (o.totalAmount ?? 0), 0);

        return { totalMaterials, pendingRequestCount, lowStockCount: lowStockMaterials.length, totalCost };
    })();

    const ws1 = wb.addWorksheet('Tổng quan');
    ws1.columns = [{ width: 35 }, { width: 20 }];
    ws1.addRow(['Báo cáo vật tư - Tổng quan']);
    ws1.addRow(['Kỳ báo cáo', dateLabel]);
    ws1.addRow([]);
    ws1.addRow(['Chỉ tiêu', 'Giá trị']);
    ws1.addRow(['Tổng loại vật tư', summaryData.totalMaterials]);
    ws1.addRow(['Tổng chi phí trong kỳ (₫)', summaryData.totalCost]);
    ws1.addRow(['Phiếu đề xuất chờ duyệt', summaryData.pendingRequestCount]);
    ws1.addRow(['Vật tư dưới ngưỡng tối thiểu', summaryData.lowStockCount]);

    // ── Sheet 2: Chi phí theo kỳ ────────────────────────────────────────────
    const purchaseOrders = await getPurchaseOrdersByPlant(plantId);
    const ws2 = wb.addWorksheet('Chi phí theo kỳ');
    ws2.columns = [
        { header: 'Kỳ', key: 'period', width: 15 },
        { header: 'Tổng chi phí (₫)', key: 'totalAmount', width: 20 },
    ];
    const costMap: Record<string, number> = {};
    purchaseOrders.forEach((o: any) => {
        const d = getOrderEffectiveDate(o);
        if (startDate && d < new Date(startDate)) return;
        if (endDate && d > new Date(endDate)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        costMap[key] = Number(((costMap[key] ?? 0) + (o.totalAmount ?? 0)).toFixed(2));
    });
    Object.entries(costMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([period, totalAmount]) => {
            ws2.addRow({ period, totalAmount });
        });

    // ── Sheet 3: Top vật tư tiêu thụ ───────────────────────────────────────
    const StockTransaction = (await import('@/models/StockTransaction')).default;
    const txFilter: Record<string, any> = { isDeleted: { $ne: true }, type: 'export' };
    if (plantId) txFilter.plantId = new mongoose.Types.ObjectId(plantId);
    if (startDate) txFilter.createdAt = { ...txFilter.createdAt, $gte: new Date(startDate) };
    if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        txFilter.createdAt = { ...txFilter.createdAt, $lte: e };
    }

    const topAgg = await StockTransaction.aggregate([
        { $match: txFilter },
        {
            $group: {
                _id: '$materialId',
                totalQty: { $sum: { $abs: '$quantity' } },
                materialName: { $first: '$materialName' },
            },
        },
        { $sort: { totalQty: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'm' } },
        { $unwind: { path: '$m', preserveNullAndEmptyArrays: false } },
    ]);

    const ws3 = wb.addWorksheet('Top vật tư tiêu thụ');
    ws3.columns = [
        { header: 'STT', key: 'stt', width: 6 },
        { header: 'Mã vật tư', key: 'code', width: 15 },
        { header: 'Tên vật tư', key: 'name', width: 30 },
        { header: 'ĐVT', key: 'unit', width: 10 },
        { header: 'SL xuất', key: 'qty', width: 12 },
    ];
    topAgg.forEach((row: any, i: number) => {
        ws3.addRow({
            stt: i + 1,
            code: row.m?.code || '',
            name: row.m?.name || row.materialName || '',
            unit: row.m?.unit || '',
            qty: row.totalQty,
        });
    });

    // ── Sheet 4: Chi phí theo NCC ───────────────────────────────────────────
    const ws4 = wb.addWorksheet('Chi phí theo NCC');
    ws4.columns = [
        { header: 'Nhà cung cấp', key: 'name', width: 30 },
        { header: 'Số đơn', key: 'count', width: 10 },
        { header: 'Tổng tiền (₫)', key: 'total', width: 20 },
    ];
    const supplierMap: Record<string, { name: string; count: number; total: number }> = {};
    purchaseOrders.forEach((o: any) => {
        const key = String(o.supplierId?._id || o.supplierId || 'unknown');
        const name = o.supplierName || o.supplierId?.name || 'Chưa xác định';
        if (!supplierMap[key]) supplierMap[key] = { name, count: 0, total: 0 };
        supplierMap[key].count += 1;
        supplierMap[key].total = Number((supplierMap[key].total + (o.totalAmount ?? 0)).toFixed(2));
    });
    Object.values(supplierMap)
        .sort((a, b) => b.total - a.total)
        .forEach((s) => {
            ws4.addRow({ name: s.name, count: s.count, total: s.total });
        });

    // ── Sheet 5: So sánh giá ────────────────────────────────────────────────
    const ws5 = wb.addWorksheet('So sánh giá');
    ws5.columns = [
        { header: 'Mã đơn hàng', key: 'code', width: 18 },
        { header: 'Nhà cung cấp', key: 'supplier', width: 25 },
        { header: 'Giá dự tính (₫)', key: 'estimated', width: 18 },
        { header: 'Giá thực tế (₫)', key: 'actual', width: 18 },
        { header: 'Chênh lệch (₫)', key: 'diff', width: 18 },
    ];
    purchaseOrders.forEach((o: any) => {
        const estimated = (o.purchaseRequestIds ?? []).reduce((s: number, r: any) => s + (r.totalEstimated ?? 0), 0);
        const actual = Number(o.totalAmount ?? 0);
        ws5.addRow({
            code: o.orderCode || '',
            supplier: o.supplierName || o.supplierId?.name || 'Chưa xác định',
            estimated: Number(estimated.toFixed(2)),
            actual,
            diff: Number((actual - estimated).toFixed(2)),
        });
    });

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `BaoCaoVatTu_${(startDate || '').replace(/-/g, '')}_${(endDate || '').replace(/-/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
};

export const exportMaterialReportExcel = async (req: Request, res: Response, next: NextFunction) => {
    const filters = buildReportFilters(req.query);
    const materialIds = await getMaterialIdsForReport(filters);
    const ExcelJS = (await import('exceljs')).default;
    const ReturnRecord = (await import('@/models/ReturnRecord')).default;
    const DistributionRecord = (await import('@/models/DistributionRecord')).default;
    const StockTransaction = (await import('@/models/StockTransaction')).default;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Hai Dang Ops';
    wb.created = new Date();

    const dateLabel =
        filters.startDate && filters.endDate
            ? `${filters.startDate.toLocaleDateString('vi-VN')} - ${filters.endDate.toLocaleDateString('vi-VN')}`
            : 'Tat ca';

    const styleWorksheet = (ws: any) => {
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        ws.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: ws.columnCount || 1 },
        };
        ws.getRow(1).eachCell((cell: any) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        ws.eachRow((row: any) => {
            row.eachCell((cell: any) => {
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                    left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                    bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                    right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                };
            });
        });
    };

    const purchaseOrders = await getPurchaseOrdersForReport(filters, materialIds);
    const refundMap = await getRefundByPurchaseOrder(ReturnRecord, filters, purchaseOrders, materialIds);

    const purchaseRows = purchaseOrders.map((order: any) => {
        const items = getReportOrderItems(order, filters, materialIds);
        const supplierInfo = getOrderSupplierInfo(order, items);
        const actualTotal = Number(sumItemsAmount(items, 'totalWithVat').toFixed(2));
        const estimatedTotal = items.reduce((sum, item) => {
            const qty = Number(item.quantityRequested ?? item.quantityOrdered ?? 0);
            const price = Number(item.unitPrice ?? 0);
            const vatRate = Number(item.vatRate ?? 0);
            return sum + Number((qty * price * (1 + vatRate / 100)).toFixed(2));
        }, 0);
        const refund = refundMap.get(String(order._id)) ?? 0;
        const netActual = Number(Math.max(0, actualTotal - refund).toFixed(2));

        return {
            code: order.orderCode || '',
            supplier: supplierInfo.supplierName || 'Chua xac dinh',
            requestCodes: (order.purchaseRequestIds ?? [])
                .map((request: any) => request.requestCode)
                .filter(Boolean)
                .join(', '),
            status: order.status,
            orderedAt: order.orderedAt ? new Date(order.orderedAt).toLocaleDateString('vi-VN') : '',
            receivedAt: order.receivedAt ? new Date(order.receivedAt).toLocaleDateString('vi-VN') : '',
            estimatedTotal: Number(estimatedTotal.toFixed(2)),
            actualTotal,
            refund,
            netActual,
            variance: Number((netActual - estimatedTotal).toFixed(2)),
            itemCount: items.length,
        };
    });

    const costMap: Record<string, number> = {};
    purchaseOrders.forEach((order: any) => {
        const period = getPeriodLabel(getOrderEffectiveDate(order), filters.groupBy);
        const items = getReportOrderItems(order, filters, materialIds);
        const net = sumItemsAmount(items, 'totalWithVat') - (refundMap.get(String(order._id)) ?? 0);
        costMap[period] = Number(((costMap[period] ?? 0) + Math.max(0, net)).toFixed(2));
    });

    const txFilter: Record<string, any> = { isDeleted: { $ne: true }, type: 'export' };
    if (filters.plantId) txFilter.plantId = new mongoose.Types.ObjectId(filters.plantId);
    if (materialIds)
        txFilter.materialId = { $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)) };
    if (filters.startDate || filters.endDate) {
        txFilter.createdAt = {};
        if (filters.startDate) txFilter.createdAt.$gte = filters.startDate;
        if (filters.endDate) txFilter.createdAt.$lte = filters.endDate;
    }

    const topAgg = await StockTransaction.aggregate([
        { $match: txFilter },
        {
            $group: {
                _id: '$materialId',
                totalQty: { $sum: { $abs: '$quantity' } },
                materialName: { $first: '$materialName' },
            },
        },
        { $sort: { totalQty: -1 } },
        { $limit: 50 },
        { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'material' } },
        { $unwind: { path: '$material', preserveNullAndEmptyArrays: true } },
    ]);

    const distributionMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        status: { $in: ['distributed', 'confirmed'] },
    };
    if (filters.plantId) distributionMatch.toPlantId = new mongoose.Types.ObjectId(filters.plantId);
    if (filters.startDate || filters.endDate) {
        distributionMatch.createdAt = {};
        if (filters.startDate) distributionMatch.createdAt.$gte = filters.startDate;
        if (filters.endDate) distributionMatch.createdAt.$lte = filters.endDate;
    }
    if (materialIds) {
        distributionMatch['items.materialId'] = {
            $in: Array.from(materialIds).map((id) => new mongoose.Types.ObjectId(id)),
        };
    }

    const distributions = await DistributionRecord.find(distributionMatch)
        .populate('fromPlantId')
        .populate('toPlantId')
        .lean();

    const distributionItemFilters = { ...filters, plantId: undefined };
    const distributionRows = distributions.flatMap((record: any) =>
        (record.items ?? [])
            .filter((item: any) => itemMatchesReportFilters(item, distributionItemFilters, materialIds))
            .map((item: any) => ({
                code: record.distributionCode || '',
                type: record.distributionType,
                status: record.status,
                fromPlant: record.fromPlantId?.name || '',
                toPlant: record.toPlantId?.name || '',
                material: item.materialName || '',
                unit: item.unit || '',
                quantity: Number(item.quantityDistributed ?? item.quantity ?? 0),
                totalAmount: Number(item.totalPrice ?? 0),
                totalWithVat: Number(item.totalWithVat ?? 0),
                createdAt: record.createdAt ? new Date(record.createdAt).toLocaleDateString('vi-VN') : '',
            }))
    );

    const supplierMap: Record<string, { supplier: string; count: Set<string>; total: number }> = {};
    purchaseOrders.forEach((order: any) => {
        getReportOrderItems(order, filters, materialIds).forEach((item: any) => {
            const supplierKey =
                toId(item.supplierId) ||
                toId(order.supplierId) ||
                getItemSupplierName(item) ||
                order.supplierName ||
                'unknown';
            if (!supplierMap[supplierKey]) {
                supplierMap[supplierKey] = {
                    supplier:
                        getItemSupplierName(item) || order.supplierName || order.supplierId?.name || 'Chua xac dinh',
                    count: new Set(),
                    total: 0,
                };
            }
            supplierMap[supplierKey].count.add(String(order._id));
            supplierMap[supplierKey].total = Number(
                (supplierMap[supplierKey].total + Number(item.totalWithVat ?? item.totalPrice ?? 0)).toFixed(2)
            );
        });
    });

    const totalPurchaseCost = purchaseRows.reduce((sum, row) => sum + row.actualTotal, 0);
    const totalRefund = purchaseRows.reduce((sum, row) => sum + row.refund, 0);
    const totalDistributionCost = distributionRows.reduce((sum, row) => sum + row.totalWithVat, 0);
    const lowStockMaterials = await getLowStockMaterialsData(req);

    const wsOverview = wb.addWorksheet('Tong quan vat tu');
    wsOverview.columns = [{ width: 34 }, { width: 24 }];
    wsOverview.addRow(['Chi tieu', 'Gia tri']);
    wsOverview.addRow(['Ky bao cao', dateLabel]);
    wsOverview.addRow(['Ngay xuat', new Date().toLocaleString('vi-VN')]);
    wsOverview.addRow(['Chi phi mua vat tu', totalPurchaseCost]);
    wsOverview.addRow(['Tong hoan tra', totalRefund]);
    wsOverview.addRow(['Net sau hoan tra', Math.max(0, totalPurchaseCost - totalRefund)]);
    wsOverview.addRow(['Gia tri cap phat vat tu', totalDistributionCost]);
    wsOverview.addRow(['So don mua vat tu', purchaseRows.length]);
    wsOverview.addRow(['So dong cap phat', distributionRows.length]);
    wsOverview.addRow(['Vat tu duoi nguong', lowStockMaterials.length]);
    styleWorksheet(wsOverview);

    const wsCost = wb.addWorksheet('Mua vat tu theo ky');
    wsCost.columns = [
        { header: 'Ky', key: 'period', width: 18 },
        { header: 'Chi phi mua vat tu net', key: 'totalAmount', width: 24, style: { numFmt: '#,##0' } },
    ];
    Object.entries(costMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([period, totalAmount]) => {
            wsCost.addRow({ period, totalAmount });
        });
    styleWorksheet(wsCost);

    const wsPurchase = wb.addWorksheet('Mua vat tu');
    wsPurchase.columns = [
        { header: 'Ma PO', key: 'code', width: 18 },
        { header: 'Nha cung cap', key: 'supplier', width: 28 },
        { header: 'Phieu de xuat', key: 'requestCodes', width: 28 },
        { header: 'Trang thai', key: 'status', width: 14 },
        { header: 'Ngay dat', key: 'orderedAt', width: 14 },
        { header: 'Ngay nhan', key: 'receivedAt', width: 14 },
        { header: 'Du tinh', key: 'estimatedTotal', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Thuc te', key: 'actualTotal', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Hoan tra', key: 'refund', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Net', key: 'netActual', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Lech gia', key: 'variance', width: 18, style: { numFmt: '#,##0' } },
        { header: 'So dong VT', key: 'itemCount', width: 12 },
    ];
    purchaseRows.forEach((row) => wsPurchase.addRow(row));
    styleWorksheet(wsPurchase);

    const wsDistribution = wb.addWorksheet('Cap phat vat tu');
    wsDistribution.columns = [
        { header: 'Ma phieu', key: 'code', width: 18 },
        { header: 'Loai', key: 'type', width: 18 },
        { header: 'Trang thai', key: 'status', width: 14 },
        { header: 'Tu co so', key: 'fromPlant', width: 20 },
        { header: 'Den co so', key: 'toPlant', width: 20 },
        { header: 'Vat tu', key: 'material', width: 30 },
        { header: 'DVT', key: 'unit', width: 10 },
        { header: 'So luong', key: 'quantity', width: 12 },
        { header: 'Tien hang', key: 'totalAmount', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Tong co VAT', key: 'totalWithVat', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Ngay tao', key: 'createdAt', width: 14 },
    ];
    distributionRows.forEach((row) => wsDistribution.addRow(row));
    styleWorksheet(wsDistribution);

    const wsTop = wb.addWorksheet('Top tieu hao');
    wsTop.columns = [
        { header: 'STT', key: 'stt', width: 8 },
        { header: 'Ma vat tu', key: 'code', width: 16 },
        { header: 'Ten vat tu', key: 'name', width: 32 },
        { header: 'Nhom', key: 'category', width: 20 },
        { header: 'DVT', key: 'unit', width: 10 },
        { header: 'SL xuat', key: 'qty', width: 14 },
    ];
    topAgg.forEach((row: any, index: number) => {
        wsTop.addRow({
            stt: index + 1,
            code: row.material?.code || '',
            name: row.material?.name || row.materialName || '',
            category: row.material?.category || '',
            unit: row.material?.unit || '',
            qty: row.totalQty,
        });
    });
    styleWorksheet(wsTop);

    const wsSupplier = wb.addWorksheet('Nha cung cap');
    wsSupplier.columns = [
        { header: 'Nha cung cap', key: 'supplier', width: 32 },
        { header: 'So don', key: 'orderCount', width: 12 },
        { header: 'Tong tien mua vat tu', key: 'total', width: 22, style: { numFmt: '#,##0' } },
    ];
    Object.values(supplierMap)
        .sort((a, b) => b.total - a.total)
        .forEach((row) => wsSupplier.addRow({ supplier: row.supplier, orderCount: row.count.size, total: row.total }));
    styleWorksheet(wsSupplier);

    const buffer = await wb.xlsx.writeBuffer();
    const startStr = req.query.startDate ? String(req.query.startDate).replace(/-/g, '') : 'all';
    const endStr = req.query.endDate ? String(req.query.endDate).replace(/-/g, '') : 'all';
    const filename = `BaoCaoVatTu_${startStr}_${endStr}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
};
