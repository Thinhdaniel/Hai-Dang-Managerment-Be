import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import Supplier from '@/models/Supplier';
import { purchaseOrderRepository } from '@/repositories/purchase-order.repository';
import { purchaseRequestRepository } from '@/repositories/purchase-request.repository';
import {
    assertPlantAccess,
    ensurePlantExists,
    generateDocumentCode,
    getUserPlantId,
    isManagerRole,
    toId,
} from '@/services/material-workflow.helpers';
import {
    buildPurchaseOrderItems,
    buildPurchaseRequestItems,
    ensureSingleSupplierForItems,
    getMaterialsMap,
    getSuppliersMap,
} from '@/services/material-domain.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializePurchaseOrder, serializePurchaseRequest } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

/** Build items khÃ´ng cáº§n materialId tá»“n táº¡i trong DB */
const buildFreeFormItems = (rawItems: any[]) => {
    return rawItems.map((item: any) => {
        const qty = Number(item.quantityOrdered ?? item.quantityRequested ?? 0);
        const price = Number(item.unitPrice ?? 0);
        const totalPrice = Number((qty * price).toFixed(2));
        // FE gá»­i vatRate 0-100, normalize vá» 0-1
        const vatRateRaw = item.vatRate != null ? Number(item.vatRate) : 8;
        const vatRate = vatRateRaw > 1 ? vatRateRaw / 100 : vatRateRaw;
        const vatAmount = Number((totalPrice * vatRate).toFixed(2));
        const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));

        return {
            materialId: item.materialId || undefined,
            materialName: item.materialName?.trim() || '',
            unit: item.unit?.trim() || '',
            proposedBy: item.proposedBy?.trim() || '',
            purpose: item.purpose?.trim() || '',
            quantityRequested: Number(item.quantityRequested ?? 0),
            quantityOrdered: qty || undefined,
            unitPrice: price || undefined,
            totalPrice: totalPrice || undefined,
            vatRate,
            vatAmount: vatAmount || undefined,
            totalWithVat: totalWithVat || undefined,
            orderDate: item.orderDate ? new Date(item.orderDate) : undefined,
            receivedDate: item.receivedDate ? new Date(item.receivedDate) : undefined,
            supplierId: item.supplierId || undefined,
            supplierName: item.supplierName?.trim() || undefined,
            supplierNote: item.supplierNote?.trim() || undefined,
            estimatedPrice: item.estimatedPrice != null ? Number(item.estimatedPrice) : undefined,
            estimatedTotal: item.estimatedTotal != null ? Number(item.estimatedTotal) : undefined,
            note: item.note?.trim() || undefined,
        };
    });
};

const buildPurchaseRequestFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
    };

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [{ requestCode: regex }, { note: regex }, { 'items.materialName': regex }, { 'items.supplierName': regex }];
    }

    if (query.status) {
        filter.status = query.status;
    }

    if (query.plantId) {
        filter.plantId = query.plantId;
    }

    if (query.requestedBy) {
        filter.requestedBy = query.requestedBy;
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

const ensurePurchaseRequestAccess = (req: Request, request: any) => {
    if (isManagerRole(req.role)) {
        return;
    }

    assertPlantAccess(req, toId(request.plantId));
};

const ensurePurchaseRequestMutationAccess = (req: Request, request: any) => {
    if (isManagerRole(req.role)) {
        return;
    }

    const userPlantId = getUserPlantId(req);
    const requestPlantId = toId(request.plantId);
    const requestedBy = toId(request.requestedBy);

    if (!userPlantId || userPlantId !== requestPlantId || req.userId !== requestedBy) {
        throw new UnAuthorizedError('Ban khong co quyen cap nhat phieu de xuat nay');
    }
};

const resolvePurchaseRequestPlantId = async (req: Request, plantId?: string) => {
    const resolvedPlantId = plantId || getUserPlantId(req);

    if (!resolvedPlantId) {
        throw new BadRequestError('Phieu de xuat mua vat tu phai gan voi mot co so');
    }

    assertPlantAccess(req, resolvedPlantId);
    await ensurePlantExists(resolvedPlantId);

    return resolvedPlantId;
};

const buildApprovalItems = async (request: any, overrideItems?: any[]) => {
    // Vá»›i free-form items (khÃ´ng cÃ³ materialId), chá»‰ cáº§n giá»¯ nguyÃªn items hiá»‡n táº¡i
    // vÃ  cáº­p nháº­t quantityApproved náº¿u cÃ³ override
    const items = (request.items ?? []).map((item: any, idx: number) => {
        const override = overrideItems?.[idx];
        return {
            ...item,
            quantityApproved: override?.quantityApproved ?? item.quantityRequested,
        };
    });

    const totalEstimated = items.reduce((sum: number, item: any) => {
        return sum + (item.totalWithVat ?? item.estimatedTotal ?? 0);
    }, 0);

    return { items, totalEstimated: Number(totalEstimated.toFixed(2)) };
};

export const getAllPurchaseRequests = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildPurchaseRequestFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || '-createdAt')
        .split(',')
        .join(' ');

    const [requests, total] = await Promise.all([
        purchaseRequestRepository.findMany(filter, { sort, skip, limit }),
        purchaseRequestRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(requests.map(serializePurchaseRequest), total, page, limit),
            message: 'Lay danh sach phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPurchaseRequestById = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    ensurePurchaseRequestAccess(req, request);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(request),
            message: 'Lay chi tiet phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createPurchaseRequest = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = await resolvePurchaseRequestPlantId(req, req.body.plantId);

    const requestCode = await generateDocumentCode({
        model: PurchaseRequest,
        field: 'requestCode',
        prefix: 'DX',
    });

    const now = new Date();
    const requestMonth = req.body.requestMonth ?? (now.getMonth() + 1);
    const requestYear = req.body.requestYear ?? now.getFullYear();

    const items = buildFreeFormItems(req.body.items);
    const totalWithVat = items.reduce((s: number, i: any) => s + (i.totalWithVat ?? 0), 0);
    const totalEstimated = items.reduce((s: number, i: any) => s + (i.totalPrice ?? i.estimatedTotal ?? 0), 0);

    const request = await purchaseRequestRepository.create({
        requestCode,
        plantId,
        requestedBy: req.userId,
        status: req.body.status === 'draft' ? 'draft' : 'pending',
        items,
        totalEstimated: Number(totalEstimated.toFixed(2)),
        totalWithVat: Number(totalWithVat.toFixed(2)),
        totalActual: 0,
        requestMonth,
        requestYear,
        note: req.body.note?.trim() || undefined,
    });

    const createdRequest = await purchaseRequestRepository.findById(String(request._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializePurchaseRequest(createdRequest),
            message: 'Tao phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updatePurchaseRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    ensurePurchaseRequestMutationAccess(req, request);

    if (request.status !== 'pending' && request.status !== 'draft') {
        throw new BadRequestError('Chi co the cap nhat phieu de xuat dang cho duyet hoac nhap');
    }

    const plantId = req.body.plantId ? await resolvePurchaseRequestPlantId(req, req.body.plantId) : toId(request.plantId);
    const nextNote = req.body.note !== undefined ? req.body.note?.trim() || undefined : request.note;
    let nextItems: any = request.items;
    let totalEstimated = Number(request.totalEstimated ?? 0);
    let totalWithVat = Number((request as any).totalWithVat ?? 0);

    if (req.body.items) {
        nextItems = buildFreeFormItems(req.body.items);
        totalEstimated = Number(nextItems.reduce((s: number, i: any) => s + (i.totalPrice ?? i.estimatedTotal ?? 0), 0).toFixed(2));
        totalWithVat = Number(nextItems.reduce((s: number, i: any) => s + (i.totalWithVat ?? 0), 0).toFixed(2));
    }

    const patch: Record<string, any> = { plantId, items: nextItems, totalEstimated, totalWithVat, note: nextNote };
    if (req.body.requestMonth) patch.requestMonth = req.body.requestMonth;
    if (req.body.requestYear) patch.requestYear = req.body.requestYear;

    const updatedRequest = await purchaseRequestRepository.updateById(String(req.params.id), patch);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updatedRequest),
            message: 'Cap nhat phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deletePurchaseRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    ensurePurchaseRequestMutationAccess(req, request);

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the huy phieu de xuat dang cho duyet');
    }

    await purchaseRequestRepository.softDeleteById(String(req.params.id), {
        isDeleted: true,
        deletedAt: new Date(),
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: null,
            message: 'Huy phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const approvePurchaseRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the duyet phieu de xuat dang cho duyet');
    }

    const preparedItems = await buildApprovalItems(request, req.body.items);
    const approvedRequest = await purchaseRequestRepository.updateById(String(req.params.id), {
        items: preparedItems.items,
        totalEstimated: preparedItems.totalEstimated,
        status: 'approved',
        approvedBy: req.userId,
        approvedAt: new Date(),
        rejectedReason: undefined,
        note: req.body.note !== undefined ? req.body.note?.trim() || undefined : request.note,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(approvedRequest),
            message: 'Duyet phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const rejectPurchaseRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the tu choi phieu de xuat dang cho duyet');
    }

    const rejectedRequest = await purchaseRequestRepository.updateById(String(req.params.id), {
        status: 'rejected',
        approvedBy: req.userId,
        approvedAt: new Date(),
        rejectedReason: req.body.reason?.trim(),
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(rejectedRequest),
            message: 'Tu choi phieu de xuat mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPendingPurchaseRequests = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildPurchaseRequestFilter({ ...req.query, status: 'pending' }, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [requests, total] = await Promise.all([
        purchaseRequestRepository.findMany(filter, { sort: '-createdAt', skip, limit }),
        purchaseRequestRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(requests.map(serializePurchaseRequest), total, page, limit),
            message: 'Lay danh sach phieu de xuat cho duyet thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const consolidatePurchaseRequests = async (req: Request, res: Response, next: NextFunction) => {
    const session = await mongoose.startSession();

    try {
        let createdOrderId = '';

        await session.withTransaction(async () => {
            const requests = await purchaseRequestRepository.findByIds(req.body.requestIds, session);

            if (requests.length !== req.body.requestIds.length) {
                throw new NotFoundError('Khong tim thay mot hoac nhieu phieu de xuat');
            }

            const invalidRequests = requests.filter((request) => request.status !== 'approved');

            if (invalidRequests.length) {
                throw new BadRequestError('Chi co the tong hop cac phieu de xuat da duyet');
            }

            const resolvedSupplierId = ensureSingleSupplierForItems(requests, req.body.supplierId ? String(req.body.supplierId) : undefined);
            const supplier = resolvedSupplierId
                ? await Supplier.findOne({
                      _id: resolvedSupplierId,
                      isDeleted: { $ne: true },
                      isActive: { $ne: false },
                  }).session(session)
                : null;

            if (resolvedSupplierId && !supplier) {
                throw new NotFoundError('Khong tim thay nha cung cap');
            }

            const aggregatedItemsMap = new Map<
                string,
                { materialId: string; unit?: string; quantity: number; unitPrice?: number; note?: string }
            >();

            requests.forEach((request) => {
                (request.items ?? []).forEach((item: any) => {
                    const itemSupplierId = toId(item.supplierId);
                    if (resolvedSupplierId && itemSupplierId && itemSupplierId !== resolvedSupplierId) {
                        throw new BadRequestError('Danh sach phieu de xuat chua vat tu cua nha cung cap khac');
                    }

                    const materialId = toId(item.materialId);
                    if (!materialId) {
                        throw new BadRequestError('Phieu de xuat chua vat tu khong hop le');
                    }
                    const currentEntry = aggregatedItemsMap.get(materialId);
                    const quantity = Number(item.quantityApproved ?? item.quantityRequested ?? 0);

                    if (currentEntry) {
                        currentEntry.quantity += quantity;
                        if (item.estimatedPrice != null) {
                            currentEntry.unitPrice = Number(item.estimatedPrice);
                        }
                    } else {
                        aggregatedItemsMap.set(materialId, {
                            materialId: String(materialId),
                            unit: item.unit,
                            quantity,
                            unitPrice: item.estimatedPrice != null ? Number(item.estimatedPrice) : undefined,
                            note: undefined,
                        });
                    }
                });
            });

            const materialIds = Array.from(aggregatedItemsMap.keys());
            const materialsMap = await getMaterialsMap(materialIds, session);
            const preparedItems = buildPurchaseOrderItems({
                items: Array.from(aggregatedItemsMap.values()),
                materialsMap,
            });
            const orderCode = await generateDocumentCode({
                model: PurchaseOrder,
                field: 'orderCode',
                prefix: 'PO',
                session,
            });

            const purchaseOrder = await purchaseOrderRepository.create(
                {
                    orderCode,
                    supplierId: supplier?._id,
                    supplierName: supplier?.name,
                    requestIds: requests.map((request) => request._id),
                    status: 'draft',
                    items: preparedItems.items,
                    totalAmount: preparedItems.totalAmount,
                    orderedBy: req.userId,
                    orderedAt: new Date(),
                    note: req.body.note?.trim() || undefined,
                },
                session
            );

            createdOrderId = String(purchaseOrder._id);

            await purchaseRequestRepository.updateMany(
                {
                    _id: { $in: req.body.requestIds },
                    isDeleted: { $ne: true },
                },
                {
                    status: 'ordered',
                },
                session
            );
        });

        const purchaseOrder = await purchaseOrderRepository.findById(createdOrderId);

        return res.status(StatusCodes.CREATED).json(
            customResponse({
                data: serializePurchaseOrder(purchaseOrder),
                message: 'Tong hop phieu de xuat va tao don dat hang thanh cong',
                status: StatusCodes.CREATED,
                success: true,
            })
        );
    } finally {
        await session.endSession();
    }
};


export const exportPurchaseRequestXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const { generatePurchaseRequestXlsx } = await import('@/utils/generatePurchaseRequestXlsx');
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    const data = serializePurchaseRequest(request);
    const buffer = await generatePurchaseRequestXlsx(data);
    const filename = `${data.requestCode ?? req.params.id}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
};
