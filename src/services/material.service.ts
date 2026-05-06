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
    const orders = await PurchaseOrder.find({ isDeleted: { $ne: true } })
        .populate('purchaseRequestIds');

    if (!plantId) {
        return orders;
    }

    return orders.filter((order: any) =>
        (order.purchaseRequestIds ?? []).some((request: any) => String(request.plantId) === plantId)
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
        const estimatedTotal = (order.purchaseRequestIds ?? []).reduce(
            (sum: number, request: any) => sum + (request.totalEstimated ?? 0),
            0
        );
        const actualTotal = Number(order.totalAmount ?? 0);

        return {
            orderId: String(order._id),
            orderCode: order.orderCode,
            supplierId: toId(order.supplierId),
            supplierName: order.supplierName || order.supplierId?.name || 'Chua gan nha cung cap',
            requestCodes: (order.purchaseRequestIds ?? []).map((request: any) => request.requestCode),
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


export const getTopMaterials = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : undefined;
    const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const txFilter: Record<string, any> = { isDeleted: { $ne: true }, type: 'export' };
    if (plantId) txFilter.plantId = new mongoose.Types.ObjectId(plantId);
    if (startDate || endDate) {
        txFilter.createdAt = {};
        if (startDate) txFilter.createdAt.$gte = startDate;
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            txFilter.createdAt.$lte = end;
        }
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
                            ...(plantId ? { plantId: new mongoose.Types.ObjectId(plantId) } : {}),
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

export const exportMaterialReportExcel = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = req.query.plantId ? String(req.query.plantId) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Material Report';

    const dateLabel = startDate && endDate
        ? `${new Date(startDate).toLocaleDateString('vi-VN')} - ${new Date(endDate).toLocaleDateString('vi-VN')}`
        : 'Tất cả';

    // ── Sheet 1: Tổng quan ──────────────────────────────────────────────────
    const summaryReq = { ...req, query: { ...req.query } } as Request;
    const summaryData = await (async () => {
        const now = new Date();
        const monthStart = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = endDate ? (() => { const d = new Date(endDate); d.setHours(23,59,59,999); return d; })() : new Date(now.getFullYear(), now.getMonth() + 1, 1);

        const [totalMaterials, pendingRequestCount, lowStockMaterials, purchaseOrders] = await Promise.all([
            Material.countDocuments({ isDeleted: { $ne: true }, isActive: { $ne: false } }),
            PurchaseRequest.countDocuments({ isDeleted: { $ne: true }, status: 'pending', ...(plantId ? { plantId } : {}) }),
            getLowStockMaterialsData(summaryReq),
            getPurchaseOrdersByPlant(plantId),
        ]);

        const totalCost = purchaseOrders
            .filter((o) => { const d = getOrderEffectiveDate(o); return d >= monthStart && d <= monthEnd; })
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
    ws2.columns = [{ header: 'Kỳ', key: 'period', width: 15 }, { header: 'Tổng chi phí (₫)', key: 'totalAmount', width: 20 }];
    const costMap: Record<string, number> = {};
    purchaseOrders.forEach((o: any) => {
        const d = getOrderEffectiveDate(o);
        if (startDate && d < new Date(startDate)) return;
        if (endDate && d > new Date(endDate)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        costMap[key] = Number(((costMap[key] ?? 0) + (o.totalAmount ?? 0)).toFixed(2));
    });
    Object.entries(costMap).sort(([a], [b]) => a.localeCompare(b)).forEach(([period, totalAmount]) => {
        ws2.addRow({ period, totalAmount });
    });

    // ── Sheet 3: Top vật tư tiêu thụ ───────────────────────────────────────
    const StockTransaction = (await import('@/models/StockTransaction')).default;
    const txFilter: Record<string, any> = { isDeleted: { $ne: true }, type: 'export' };
    if (plantId) txFilter.plantId = new mongoose.Types.ObjectId(plantId);
    if (startDate) txFilter.createdAt = { ...txFilter.createdAt, $gte: new Date(startDate) };
    if (endDate) { const e = new Date(endDate); e.setHours(23,59,59,999); txFilter.createdAt = { ...txFilter.createdAt, $lte: e }; }

    const topAgg = await StockTransaction.aggregate([
        { $match: txFilter },
        { $group: { _id: '$materialId', totalQty: { $sum: { $abs: '$quantity' } }, materialName: { $first: '$materialName' } } },
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
        ws3.addRow({ stt: i + 1, code: row.m?.code || '', name: row.m?.name || row.materialName || '', unit: row.m?.unit || '', qty: row.totalQty });
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
    Object.values(supplierMap).sort((a, b) => b.total - a.total).forEach((s) => {
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
    return res.send(buffer);
};