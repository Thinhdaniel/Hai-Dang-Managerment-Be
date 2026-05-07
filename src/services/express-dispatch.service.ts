import { BadRequestError } from '@/errors/customError';
import DistributionRecord from '@/models/DistributionRecord';
import PurchaseOrder from '@/models/PurchaseOrder';
import StockTransaction from '@/models/StockTransaction';
import Supplier from '@/models/Supplier';
import { generateDocumentCode, ensurePlantExists } from '@/services/material-workflow.helpers';
import customResponse from '@/utils/response';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

export const expressDispatch = async (req: Request, res: Response, next: NextFunction) => {
    const MAIN_PLANT_ID = process.env.MAIN_PLANT_ID;
    if (!MAIN_PLANT_ID) throw new BadRequestError('Chua cau hinh MAIN_PLANT_ID');

    const { items, toPlantId, note } = req.body;

    await ensurePlantExists(toPlantId);

    const CS1_OID = new mongoose.Types.ObjectId(MAIN_PLANT_ID);
    const toPlantOID = new mongoose.Types.ObjectId(toPlantId);

    const session = await mongoose.startSession();
    session.startTransaction();

    let result: { orderCode: string; distributionCode: string; newSupplierIds?: string[] };

    try {
        const newSupplierIds: string[] = [];
        const processedItems = [];

        // Xử lý từng item: tạo supplier nếu cần
        for (const item of items) {
            let finalSupplierId: mongoose.Types.ObjectId;
            let supplierName: string;

            if (item.quickSupplier) {
                // Tạo supplier mới
                const [supplier] = await Supplier.create([{
                    name: item.quickSupplier.name.trim(),
                    phone: item.quickSupplier.phone?.trim(),
                    address: item.quickSupplier.address?.trim(),
                    supplyTypes: ['material'],
                    isActive: true,
                    createdBy: req.userId,
                }], { session });
                
                finalSupplierId = supplier._id;
                supplierName = supplier.name;
                newSupplierIds.push(supplier._id.toString());
            } else {
                // Validate supplierId tồn tại
                const supplier = await Supplier.findOne({ 
                    _id: item.supplierId, 
                    isDeleted: { $ne: true } 
                }).session(session);
                
                if (!supplier) {
                    throw new BadRequestError(`Nha cung cap ${item.supplierId} khong ton tai`);
                }
                
                finalSupplierId = supplier._id;
                supplierName = supplier.name;
            }

            // Tính toán
            const qty = Number(item.quantity);
            const price = Number(item.unitPrice);
            const vat = Number(item.vatRate ?? 0);
            const totalPrice = Number((qty * price).toFixed(2));
            const vatAmount = Number((totalPrice * vat / 100).toFixed(2));
            const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));

            processedItems.push({
                ...item,
                qty,
                price,
                vat,
                totalPrice,
                vatAmount,
                totalWithVat,
                supplierId: finalSupplierId,
                supplierName,
            });
        }

        const grandTotal = Number(processedItems.reduce((s, i) => s + i.totalPrice, 0).toFixed(2));
        const grandVat = Number(processedItems.reduce((s, i) => s + i.vatAmount, 0).toFixed(2));
        const grandWithVat = Number(processedItems.reduce((s, i) => s + i.totalWithVat, 0).toFixed(2));

        // 1. Tạo PurchaseOrder (received)
        const orderCode = await generateDocumentCode({ model: PurchaseOrder, field: 'orderCode', prefix: 'PO', session });

        const [order] = await PurchaseOrder.create([{
            orderCode,
            status: 'received',
            items: processedItems.map((i) => ({
                materialName: i.materialName.trim(),
                unit: i.unit.trim(),
                quantityOrdered: i.qty,
                quantityRequested: i.qty,
                unitPrice: i.price,
                totalPrice: i.totalPrice,
                vatRate: i.vat,
                vatAmount: i.vatAmount,
                totalWithVat: i.totalWithVat,
                supplierId: i.supplierId,
                supplierName: i.supplierName,
            })),
            totalAmount: grandTotal,
            totalVat: grandVat,
            totalWithVat: grandWithVat,
            createdBy: req.userId,
            receivedBy: req.userId,
            receivedAt: new Date(),
            note: note?.trim() || undefined,
        }], { session });

        // 2. StockTransaction import (audit trail)
        await StockTransaction.create(
            processedItems.map((i) => ({
                type: 'import',
                materialName: i.materialName.trim(),
                plantId: CS1_OID,
                quantity: i.qty,
                stockBefore: 0,
                stockAfter: i.qty,
                relatedId: order._id,
                relatedType: 'express_dispatch',
                performedBy: req.userId,
                note: `[Xuat khan cap] Nhap vao CS1${note?.trim() ? ' - ' + note.trim() : ''}`,
            })),
            { session }
        );

        // 3. Tạo DistributionRecord (distributed)
        const distributionCode = await generateDocumentCode({ model: DistributionRecord, field: 'distributionCode', prefix: 'CP', session });

        const [distribution] = await (DistributionRecord as any).create([{
            distributionCode,
            fromPlantId: CS1_OID,
            toPlantId: toPlantOID,
            purchaseOrderId: order._id,
            status: 'distributed',
            items: processedItems.map((i) => ({
                materialName: i.materialName.trim(),
                unit: i.unit.trim(),
                quantity: i.qty,
                quantityRequested: i.qty,
                unitPrice: i.price,
                totalPrice: i.totalPrice,
                vatRate: i.vat,
                vatAmount: i.vatAmount,
                totalWithVat: i.totalWithVat,
                note: i.note?.trim() || undefined,
            })),
            totalAmount: grandTotal,
            totalVatAmount: grandVat,
            totalWithVat: grandWithVat,
            distributedBy: req.userId,
            distributedAt: new Date(),
            note: note?.trim() || undefined,
        }], { session });

        // 4. StockTransaction export (audit trail)
        await StockTransaction.create(
            processedItems.map((i) => ({
                type: 'export',
                materialName: i.materialName.trim(),
                plantId: CS1_OID,
                quantity: -i.qty,
                stockBefore: i.qty,
                stockAfter: 0,
                relatedId: distribution._id,
                relatedType: 'express_dispatch',
                performedBy: req.userId,
                note: `[Xuat khan cap] Xuat khoi CS1${note?.trim() ? ' - ' + note.trim() : ''}`,
            })),
            { session }
        );

        await session.commitTransaction();
        result = { 
            orderCode, 
            distributionCode, 
            newSupplierIds: newSupplierIds.length > 0 ? newSupplierIds : undefined 
        };
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
    }

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: result,
            message: `Xuat khan cap thanh cong (${items.length} vat tu)`,
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};
