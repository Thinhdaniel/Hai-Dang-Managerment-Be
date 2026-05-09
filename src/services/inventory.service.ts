import { BadRequestError, NotFoundError } from '@/errors/customError';
import InventoryStock from '@/models/InventoryStock';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
import StockTransaction from '@/models/StockTransaction';
import { inventoryRepository } from '@/repositories/inventory.repository';
import { stockTransactionRepository } from '@/repositories/stock-transaction.repository';
import {
    applyStockMovement,
    buildPlantScopeFilter,
    ensureMaterialExists,
    ensurePlantExists,
    getUserPlantId,
    isManagerRole,
    toId,
} from '@/services/material-workflow.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializeInventoryStock, serializeMaterial, serializeStockTransaction } from '@/utils/materialSerializers';
import { generateImportTemplate, generateStockReport, generateHistoryReport } from '@/utils/generateInventoryXlsx';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import ExcelJS from 'exceljs';

const MAIN_PLANT_ID = process.env.MAIN_PLANT_ID || '';

const buildInventoryMaterialFilter = (query: Request['query']) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        isActive: { $ne: false },
    };
    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [{ name: regex }, { code: regex }];
    }

    if (query.category) {
        filter.category = query.category;
    }

    return filter;
};

const buildInventoryTransactionFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
    };
    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [{ materialName: regex }, { note: regex }];
    }

    if (query.materialId) {
        filter.materialId = query.materialId;
    }

    if (query.plantId) {
        filter.plantId = query.plantId;
    }

    if (query.type) {
        filter.type = query.type;
    }

    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) {
            filter.createdAt.$gte = new Date(String(query.startDate));
        }
        if (query.endDate) {
            const endDate = new Date(String(query.endDate));
            endDate.setHours(23, 59, 59, 999);
            filter.createdAt.$lte = endDate;
        }
    }

    if (!isManagerRole(req.role)) {
        filter.plantId = getUserPlantId(req);
    }

    return filter;
};

export const getInventoryStocks = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = isManagerRole(req.role) ? (req.query.plantId ? String(req.query.plantId) : undefined) : getUserPlantId(req);
    const materialFilter = buildInventoryMaterialFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    if (plantId) {
        const [materials, total, plant] = await Promise.all([
            Material.find(materialFilter).sort('name').skip(skip).limit(limit),
            Material.countDocuments(materialFilter),
            Plant.findOne({ _id: plantId, isDeleted: { $ne: true } }),
        ]);

        if (!plant) {
            throw new NotFoundError('Khong tim thay co so');
        }

        const inventoryStocks: any[] = await (InventoryStock as any)
            .find({
                plantId,
                materialId: { $in: materials.map((material) => material._id) },
                isDeleted: { $ne: true },
            })
            .populate('materialId');

        const inventoryMap = new Map(inventoryStocks.map((stock) => [String(stock.materialId?._id ?? stock.materialId), stock]));
        const data = materials.map((material) =>
            serializeInventoryStock({
                materialId: material,
                plantId: plant,
                currentStock: inventoryMap.get(String(material._id))?.currentStock ?? 0,
                minStockLevel: material.minStockLevel,
                lastUpdated: inventoryMap.get(String(material._id))?.lastUpdated,
            })
        );

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: buildPaginatedResponse(data, total, page, limit),
                message: 'Lay ton kho vat tu theo co so thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const matchingMaterialIds = await Material.find(materialFilter).distinct('_id');
    const inventoryFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        materialId: { $in: matchingMaterialIds },
    };
    const [inventoryStocks, total] = await Promise.all([
        inventoryRepository.findMany(inventoryFilter, { sort: '-lastUpdated', skip, limit }),
        inventoryRepository.countDocuments(inventoryFilter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(inventoryStocks.map(serializeInventoryStock), total, page, limit),
            message: 'Lay danh sach ton kho vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getInventoryByMaterial = async (req: Request, res: Response, next: NextFunction) => {
    const material = await ensureMaterialExists(String(req.params.materialId));
    const filter: Record<string, any> = {
        materialId: req.params.materialId,
        isDeleted: { $ne: true },
        ...buildPlantScopeFilter(req),
    };

    const stocks = await inventoryRepository.findMany(filter, { sort: 'plantId' });

    if (!stocks.length && !isManagerRole(req.role)) {
        const userPlantId = getUserPlantId(req);
        const plant = userPlantId ? await ensurePlantExists(userPlantId) : null;

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    material: serializeMaterial(material),
                    stocks: plant
                        ? [
                              serializeInventoryStock({
                                  materialId: material,
                                  plantId: plant,
                                  currentStock: 0,
                                  minStockLevel: material.minStockLevel,
                              }),
                          ]
                        : [],
                },
                message: 'Lay ton kho vat tu theo tung co so thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                material: serializeMaterial(material),
                stocks: stocks.map(serializeInventoryStock),
            },
            message: 'Lay ton kho vat tu theo tung co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getInventoryTransactions = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildInventoryTransactionFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [transactions, total] = await Promise.all([
        stockTransactionRepository.findMany(filter, { sort: '-createdAt', skip, limit }),
        stockTransactionRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(transactions.map(serializeStockTransaction), total, page, limit),
            message: 'Lay lich su giao dich ton kho thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const adjustInventory = async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();

    try {
        let transactionId = '';
        let adjustedPlantId = '';
        let adjustedMaterialId = '';

        await session.withTransaction(async () => {
            const [material, plant] = await Promise.all([
                ensureMaterialExists(String(req.body.materialId), session),
                ensurePlantExists(String(req.body.plantId), session),
            ]);

            const { transaction } = await applyStockMovement({
                materialId: String(material._id),
                materialName: material.name,
                plantId: String(plant._id),
                quantity: Number(req.body.quantity),
                type: 'adjust',
                relatedType: 'manual',
                performedBy: req.userId,
                note: req.body.note?.trim() || undefined,
                session,
            });

            transactionId = String(transaction._id);
            adjustedPlantId = String(plant._id);
            adjustedMaterialId = String(material._id);
        });

        const transaction = await stockTransactionRepository.findMany(
            {
                _id: transactionId,
                isDeleted: { $ne: true },
            },
            { limit: 1 }
        );
        const inventoryStock = await inventoryRepository.findOne({
            materialId: adjustedMaterialId,
            plantId: adjustedPlantId,
            isDeleted: { $ne: true },
        });

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    transaction: transaction[0] ? serializeStockTransaction(transaction[0]) : null,
                    inventory: inventoryStock ? serializeInventoryStock(inventoryStock) : null,
                },
                message: 'Dieu chinh ton kho thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    } finally {
        await session.endSession();
    }
};

/**
 * PUT /api/inventory/adjust
 * Ghi đè tồn kho trực tiếp về giá trị newStock (chỉ Admin).
 * Ghi StockTransaction type=adjust với stockBefore/stockAfter đầy đủ.
 */
export const overrideInventoryStock = async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();

    try {
        let transactionId = '';
        let adjustedPlantId = '';
        let adjustedMaterialId = '';

        await session.withTransaction(async () => {
            const [material, plant] = await Promise.all([
                ensureMaterialExists(String(req.body.materialId), session),
                ensurePlantExists(String(req.body.plantId), session),
            ]);

            const newStock = Number(req.body.newStock);
            if (isNaN(newStock) || newStock < 0) {
                throw new BadRequestError('Ton kho moi phai la so nguyen khong am');
            }

            const materialId = String(material._id);
            const plantId = String(plant._id);

            // Lấy hoặc tạo InventoryStock
            let inventoryStock: any = await (InventoryStock as any)
                .findOne({ materialId, plantId, isDeleted: { $ne: true } })
                .session(session);

            if (!inventoryStock) {
                inventoryStock = new (InventoryStock as any)({ materialId, plantId, currentStock: 0 });
            }

            const stockBefore = Number(inventoryStock.currentStock ?? 0);
            const stockAfter = newStock;

            // Ghi đè trực tiếp
            inventoryStock.currentStock = stockAfter;
            await inventoryStock.save({ session });

            // Ghi audit log
            const performerName = (req as any).user?.name ?? req.userId ?? 'unknown';
            const auditNote =
                `${req.body.reason?.trim() ?? 'Dieu chinh thu cong'} (dieu chinh boi ${performerName})`;

            const transaction = new StockTransaction({
                type: 'adjust',
                materialId,
                materialName: material.name,
                plantId,
                quantity: stockAfter - stockBefore,
                stockBefore,
                stockAfter,
                relatedType: 'manual',
                performedBy: req.userId,
                note: auditNote,
            });

            await transaction.save({ session });

            transactionId = String(transaction._id);
            adjustedPlantId = plantId;
            adjustedMaterialId = materialId;
        });

        const [transactions, inventoryStock] = await Promise.all([
            stockTransactionRepository.findMany({ _id: transactionId, isDeleted: { $ne: true } }, { limit: 1 }),
            inventoryRepository.findOne({
                materialId: adjustedMaterialId,
                plantId: adjustedPlantId,
                isDeleted: { $ne: true },
            }),
        ]);

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    transaction: transactions[0] ? serializeStockTransaction(transactions[0]) : null,
                    inventory: inventoryStock ? serializeInventoryStock(inventoryStock) : null,
                },
                message: 'Ghi de ton kho thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    } finally {
        await session.endSession();
    }
};



// ─── INITIALIZE STOCK ────────────────────────────────────────────────────────

export const initializeStock = async (req: Request, res: Response, next: NextFunction) => {
    const { plantId, items, reason } = req.body as {
        plantId: string;
        items: Array<{ materialId: string; currentStock: number; note?: string }>;
        reason: string;
    };

    if (!plantId || String(plantId) !== MAIN_PLANT_ID) {
        throw new BadRequestError('Chi CS1 moi co the nhap ton kho ban dau');
    }

    if (!Array.isArray(items) || items.length === 0) {
        throw new BadRequestError('Danh sach vat tu khong duoc de trong');
    }

    if (!reason?.trim()) {
        throw new BadRequestError('Ly do nhap khong duoc de trong');
    }

    const plant = await ensurePlantExists(plantId);
    const errors: Array<{ index: number; materialId: string; reason: string }> = [];
    let successCount = 0;

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const qty = Number(item.currentStock);

                if (isNaN(qty) || qty < 0) {
                    errors.push({ index: i, materialId: item.materialId, reason: 'So luong phai >= 0' });
                    continue;
                }

                let material: any;
                try {
                    material = await ensureMaterialExists(String(item.materialId), session);
                } catch {
                    errors.push({ index: i, materialId: item.materialId, reason: 'Khong tim thay vat tu' });
                    continue;
                }

                const materialId = String(material._id);
                const plantIdStr = String(plant._id);

                let stock: any = await (InventoryStock as any)
                    .findOne({ materialId, plantId: plantIdStr, isDeleted: { $ne: true } })
                    .session(session);

                if (!stock) {
                    stock = new (InventoryStock as any)({ materialId, plantId: plantIdStr, currentStock: 0 });
                }

                const stockBefore = Number(stock.currentStock ?? 0);
                stock.currentStock = qty;
                await stock.save({ session });

                const noteText = [reason.trim(), item.note?.trim()].filter(Boolean).join(' | ');
                const tx = new StockTransaction({
                    type: 'adjust',
                    materialId,
                    materialName: material.name,
                    plantId: plantIdStr,
                    quantity: qty - stockBefore,
                    stockBefore,
                    stockAfter: qty,
                    relatedType: 'manual',
                    performedBy: req.userId,
                    note: noteText,
                });
                await tx.save({ session });
                successCount++;
            }
        });
    } finally {
        await session.endSession();
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { success: successCount, failed: errors.length, errors },
            message: `Da nhap ton kho cho ${successCount} vat tu`,
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// ─── PREVIEW IMPORT EXCEL ────────────────────────────────────────────────────

export const previewInventoryImport = async (req: Request, res: Response, next: NextFunction) => {
    const { plantId } = req.body as { plantId: string };

    if (!plantId || String(plantId) !== MAIN_PLANT_ID) {
        throw new BadRequestError('Chi CS1 moi co the import ton kho');
    }

    if (!req.file) {
        throw new BadRequestError('Vui long chon file Excel');
    }

    const plant = await ensurePlantExists(plantId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(req.file.buffer) as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestError('File Excel khong hop le');

    type PreviewRow = {
        row: number;
        materialCode: string;
        materialName?: string;
        currentStock?: number;
        newStock: number;
        note: string;
        isValid: boolean;
        reason?: string;
    };

    const dataRows: Array<{ rowNum: number; materialCode: string; qty: number; note: string }> = [];
    ws.eachRow((row, rowNum) => {
        if (rowNum <= 6) return;
        const materialCode = String(row.getCell(2).value ?? '').trim().toUpperCase();
        if (!materialCode) return;
        const qty = Number(row.getCell(5).value ?? 0);
        const note = String(row.getCell(6).value ?? '').trim();
        dataRows.push({ rowNum, materialCode, qty, note });
    });

    const codes = dataRows.map((r) => r.materialCode);
    const materials = await Material.find({
        code: { $in: codes.map((c) => new RegExp(`^${c}$`, 'i')) },
        isDeleted: { $ne: true },
    }).select('_id code name').lean();
    const materialMap = new Map(materials.map((m: any) => [m.code.toUpperCase(), m]));

    const stocks = await (InventoryStock as any).find({
        materialId: { $in: materials.map((m: any) => m._id) },
        plantId: plant._id,
        isDeleted: { $ne: true },
    }).lean();
    const stockMap = new Map(stocks.map((s: any) => [String(s.materialId), Number(s.currentStock ?? 0)]));

    const rows: PreviewRow[] = dataRows.map(({ rowNum, materialCode, qty, note }) => {
        if (isNaN(qty) || qty < 0) {
            return { row: rowNum, materialCode, newStock: qty, note, isValid: false, reason: 'So luong phai >= 0' };
        }
        const material = materialMap.get(materialCode);
        if (!material) {
            return { row: rowNum, materialCode, newStock: qty, note, isValid: false, reason: 'Khong tim thay vat tu' };
        }
        const currentStock = stockMap.get(String(material._id)) ?? 0;
        return {
            row: rowNum,
            materialCode,
            materialName: (material as any).name as string,
            currentStock: currentStock as number,
            newStock: qty,
            note,
            isValid: true as const,
        };
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                summary: {
                    totalRows: rows.length,
                    validRows: rows.filter((r) => r.isValid).length,
                    invalidRows: rows.filter((r) => !r.isValid).length,
                },
                rows,
            },
            message: 'Xem truoc import ton kho thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// ─── IMPORT EXCEL ────────────────────────────────────────────────────────────

export const importExcel = async (req: Request, res: Response, next: NextFunction) => {
    const { plantId, reason } = req.body as { plantId: string; reason: string };

    if (!plantId || String(plantId) !== MAIN_PLANT_ID) {
        throw new BadRequestError('Chi CS1 moi co the import ton kho');
    }

    if (!reason?.trim()) {
        throw new BadRequestError('Ly do nhap khong duoc de trong');
    }

    if (!req.file) {
        throw new BadRequestError('Vui long chon file Excel');
    }

    const plant = await ensurePlantExists(plantId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(req.file.buffer) as any);
    const ws = wb.worksheets[0];

    if (!ws) {
        throw new BadRequestError('File Excel khong hop le');
    }

    const errors: Array<{ row: number; materialCode: string; reason: string }> = [];
    let successCount = 0;

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            ws.eachRow((row, rowNum) => {
                if (rowNum <= 6) return; // skip header rows 1-6

                const materialCode = String(row.getCell(2).value ?? '').trim().toUpperCase();
                if (!materialCode) return;

                // We'll process async outside eachRow
            });

            // Process rows 7+
            const dataRows: Array<{ rowNum: number; materialCode: string; qty: number; note: string }> = [];
            ws.eachRow((row, rowNum) => {
                if (rowNum <= 6) return;
                const materialCode = String(row.getCell(2).value ?? '').trim().toUpperCase();
                if (!materialCode) return;
                const qty = Number(row.getCell(5).value ?? 0);
                const note = String(row.getCell(6).value ?? '').trim();
                dataRows.push({ rowNum, materialCode, qty, note });
            });

            for (const { rowNum, materialCode, qty, note } of dataRows) {
                if (isNaN(qty) || qty < 0) {
                    errors.push({ row: rowNum, materialCode, reason: 'So luong phai >= 0' });
                    continue;
                }

                const material: any = await Material.findOne({
                    code: { $regex: new RegExp(`^${materialCode}$`, 'i') },
                    isDeleted: { $ne: true },
                }).session(session);

                if (!material) {
                    errors.push({ row: rowNum, materialCode, reason: 'Khong tim thay vat tu' });
                    continue;
                }

                const materialId = String(material._id);
                const plantIdStr = String(plant._id);

                let stock: any = await (InventoryStock as any)
                    .findOne({ materialId, plantId: plantIdStr, isDeleted: { $ne: true } })
                    .session(session);

                if (!stock) {
                    stock = new (InventoryStock as any)({ materialId, plantId: plantIdStr, currentStock: 0 });
                }

                const stockBefore = Number(stock.currentStock ?? 0);
                stock.currentStock = qty;
                await stock.save({ session });

                const noteText = [reason.trim(), note].filter(Boolean).join(' | ');
                const tx = new StockTransaction({
                    type: 'adjust',
                    materialId,
                    materialName: material.name,
                    plantId: plantIdStr,
                    quantity: qty - stockBefore,
                    stockBefore,
                    stockAfter: qty,
                    relatedType: 'manual',
                    performedBy: req.userId,
                    note: noteText,
                });
                await tx.save({ session });
                successCount++;
            }
        });
    } finally {
        await session.endSession();
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { success: successCount, failed: errors.length, errors },
            message: `Import thanh cong ${successCount} vat tu`,
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// ─── DOWNLOAD TEMPLATE ───────────────────────────────────────────────────────

export const downloadTemplate = async (req: Request, res: Response, next: NextFunction) => {
    const buffer = await generateImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="mau-nhap-ton-kho.xlsx"');
    res.send(Buffer.from(buffer));
};

// ─── EXPORT EXCEL ────────────────────────────────────────────────────────────

export const exportExcel = async (req: Request, res: Response, next: NextFunction) => {
    const { type = 'stock', plantId, startDate, endDate } = req.query as {
        type?: string;
        plantId?: string;
        startDate?: string;
        endDate?: string;
    };

    let plantName = 'Tất cả';
    if (plantId) {
        const plant = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } });
        if (plant) plantName = plant.name;
    }

    if (type === 'history') {
        const filter: Record<string, any> = { isDeleted: { $ne: true } };
        if (plantId) filter.plantId = plantId;
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                filter.createdAt.$lte = end;
            }
        }

        const transactions = await StockTransaction.find(filter)
            .populate('materialId', 'code name unit')
            .populate('performedBy', 'name email')
            .sort('-createdAt')
            .lean();

        const rows = transactions.map((t: any) => ({
            createdAt: t.createdAt,
            materialCode: t.materialId?.code || '',
            materialName: t.materialName || t.materialId?.name || '',
            unit: t.materialId?.unit || '',
            type: t.type,
            quantity: t.quantity,
            stockBefore: t.stockBefore,
            stockAfter: t.stockAfter,
            relatedType: t.relatedType,
            performedBy: t.performedBy?.name || t.performedBy?.email || '',
            note: t.note || '',
        }));

        const buffer = await generateHistoryReport(rows, plantName, startDate, endDate);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="lich-su-nhap-xuat.xlsx"');
        return res.send(Buffer.from(buffer));
    }

    // type === 'stock'
    const materialFilter: Record<string, any> = { isDeleted: { $ne: true }, isActive: { $ne: false } };
    const materials = await Material.find(materialFilter).sort('name').lean();

    const stockFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        materialId: { $in: materials.map((m: any) => m._id) },
    };
    if (plantId) stockFilter.plantId = plantId;

    const stocks = await (InventoryStock as any).find(stockFilter).lean();
    const stockMap = new Map(stocks.map((s: any) => [String(s.materialId), s as any]));

    const rows = materials.map((m: any) => {
        const stock = stockMap.get(String(m._id)) as any;
        return {
            code: m.code || '',
            name: m.name,
            category: m.category,
            unit: m.unit,
            currentStock: Number(stock?.currentStock ?? 0),
            minStockLevel: m.minStockLevel,
        };
    });

    const buffer = await generateStockReport(rows, plantName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bao-cao-ton-kho.xlsx"');
    return res.send(Buffer.from(buffer));
};
