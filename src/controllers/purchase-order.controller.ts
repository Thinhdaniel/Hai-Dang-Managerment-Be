import * as purchaseOrderService from '@/services/purchase-order.service';
import {
    getPurchaseReceiptScans as getPurchaseReceiptScansService,
    previewPurchaseReceiptScan as previewPurchaseReceiptScanService,
    recordReceiptScanMappings as recordReceiptScanMappingsService,
} from '@/services/purchase-receipt-scan.service';
import asyncHandler from '@/utils/asyncHandler';
import { NextFunction, Request, Response } from 'express';

export const getAllPurchaseOrders = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.getAllPurchaseOrders(req, res, next);
});
export const getPurchaseOrderById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.getPurchaseOrderById(req, res, next);
});
export const getOutstandingPurchaseShortages = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.getOutstandingPurchaseShortages(req, res, next);
});
export const createPurchaseOrder = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.createPurchaseOrder(req, res, next);
});
export const updatePurchaseOrder = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.updatePurchaseOrder(req, res, next);
});
export const cancelPurchaseOrderItem = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.cancelPurchaseOrderItem(req, res, next);
});
export const confirmPurchaseOrder = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.confirmPurchaseOrder(req, res, next);
});
export const receivePurchaseOrder = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.receivePurchaseOrder(req, res, next);
});
export const previewPurchaseReceiptScan = asyncHandler(async (req: Request, res: Response) => {
    return await previewPurchaseReceiptScanService(req, res);
});
export const getPurchaseReceiptScans = asyncHandler(async (req: Request, res: Response) => {
    return await getPurchaseReceiptScansService(req, res);
});
export const recordReceiptScanMappings = asyncHandler(async (req: Request, res: Response) => {
    return await recordReceiptScanMappingsService(req, res);
});
export const linkPurchaseOrderItemMaterial = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.linkPurchaseOrderItemMaterial(req, res, next);
});
export const createMaterialForPurchaseOrderItem = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
        return await purchaseOrderService.createMaterialForPurchaseOrderItem(req, res, next);
    }
);
export const ignorePurchaseOrderItemInventory = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
        return await purchaseOrderService.ignorePurchaseOrderItemInventory(req, res, next);
    }
);
export const deletePurchaseOrder = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.deletePurchaseOrder(req, res, next);
});
export const exportPurchaseOrderXlsx = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.exportPurchaseOrderXlsx(req, res, next);
});
export const exportRangePurchaseOrdersXlsx = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    return await purchaseOrderService.exportRangePurchaseOrdersXlsx(req, res, next);
});
