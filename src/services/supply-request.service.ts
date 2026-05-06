import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import DistributionRecord from '@/models/DistributionRecord';
import PurchaseRequest from '@/models/PurchaseRequest';
import InventoryStock from '@/models/InventoryStock';
import { distributionRepository } from '@/repositories/distribution.repository';
import { purchaseRequestRepository } from '@/repositories/purchase-request.repository';
import {
    applyStockMovement,
    ensurePlantExists,
    generateDocumentCode,
    getUserPlantId,
    isManagerRole,
    toId,
} from '@/services/material-workflow.helpers';
import { buildDistributionItems, getMaterialsMap } from '@/services/material-domain.helpers';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializeDistributionRecord, serializePurchaseRequest } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

/** ID cá»§a CS1 (cÆ¡ sá»Ÿ chÃ­nh, nÆ¡i lÆ°u kho vÃ  xá»­ lÃ½ Ä‘á» xuáº¥t) */
const getMainPlantId = () => {
    const id = process.env.MAIN_PLANT_ID;
    if (!id) throw new BadRequestError('MAIN_PLANT_ID chua duoc cau hinh trong he thong');
    return id;
};

/** CS1 check: user thuá»™c CS1 hay khÃ´ng */
const isMainPlant = (req: Request): boolean => {
    const userPlantId = getUserPlantId(req);
    const mainPlantId = process.env.MAIN_PLANT_ID;
    return !!mainPlantId && userPlantId === mainPlantId;
};

const buildSupplyRequestFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        requestType: 'supply_request',
    };

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });
    if (regex) {
        filter.$or = [{ requestCode: regex }, { note: regex }, { 'items.materialName': regex }];
    }

    if (query.status) filter.status = query.status;

    if (query.fromPlantId) filter.fromPlantId = query.fromPlantId;

    if (query.requestedBy) filter.requestedBy = query.requestedBy;

    if (query.toPlantId) filter.toPlantId = query.toPlantId;

    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) filter.createdAt.$gte = new Date(String(query.startDate));
        if (query.endDate) {
            const endDate = new Date(String(query.endDate));
            endDate.setHours(23, 59, 59, 999);
            filter.createdAt.$lte = endDate;
        }
    }

    // PhÃ¢n quyá»n: Manager/Admin xem táº¥t cáº£; CS1 xem theo toPlantId; CS khÃ¡c xem cá»§a mÃ¬nh
    if (!isManagerRole(req.role)) {
        const userPlantId = getUserPlantId(req);
        if (isMainPlant(req)) {
            // CS1 xem phiáº¿u gá»­i Ä‘áº¿n CS1
            filter.toPlantId = getMainPlantId();
        } else {
            // CS khÃ¡c chá»‰ xem phiáº¿u cá»§a mÃ¬nh
            filter.fromPlantId = userPlantId;
        }
    }

    return filter;
};

export const getAllSupplyRequests = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildSupplyRequestFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || '-createdAt').split(',').join(' ');

    const [requests, total] = await Promise.all([
        purchaseRequestRepository.findMany(filter, { sort, skip, limit }),
        purchaseRequestRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(requests.map(serializePurchaseRequest), total, page, limit),
            message: 'Lay danh sach phieu de xuat cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getSupplyRequestById = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== 'supply_request') {
        throw new NotFoundError('Khong tim thay phieu de xuat cap vat tu');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(request),
            message: 'Lay chi tiet phieu de xuat cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createSupplyRequest = async (req: Request, res: Response, next: NextFunction) => {
    // CS1 khÃ´ng Ä‘Æ°á»£c táº¡o supply_request (CS1 chá»‰ xá»­ lÃ½, khÃ´ng xin)
    if (isMainPlant(req)) {
        throw new UnAuthorizedError('Co so chinh (CS1) khong the tao phieu de xuat cap vat tu');
    }

    const userPlantId = getUserPlantId(req);
    if (!userPlantId) throw new BadRequestError('Nguoi dung chua duoc gan co so');

    const mainPlantId = getMainPlantId();

    await Promise.all([
        ensurePlantExists(userPlantId),
        ensurePlantExists(mainPlantId),
    ]);

    const requestCode = await generateDocumentCode({
        model: PurchaseRequest,
        field: 'requestCode',
        prefix: 'YC',
    });

    // Nhập tay: không cần materialId, chỉ cần materialName + unit
    const items = req.body.items.map((item: any) => ({
        materialName: item.materialName.trim(),
        unit: item.unit.trim(),
        quantityRequested: Number(item.quantityRequested),
        note: item.note?.trim() || undefined,
    }));

    const request = await purchaseRequestRepository.create({
        requestCode,
        requestType: 'supply_request',
        plantId: userPlantId,          // backward compat
        fromPlantId: userPlantId,
        toPlantId: mainPlantId,
        requestedBy: req.userId,
        status: 'pending',
        items,
        totalEstimated: 0,
        totalActual: 0,
        note: req.body.note?.trim() || undefined,
        requestDate: req.body.requestDate ? new Date(req.body.requestDate) : new Date(),
    });

    const created = await purchaseRequestRepository.findById(String(request._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializePurchaseRequest(created),
            message: 'Tao phieu de xuat cap vat tu thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updateSupplyRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== 'supply_request') {
        throw new NotFoundError('Khong tim thay phieu de xuat cap vat tu');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the cap nhat phieu dang cho duyet');
    }

    // Cho phÃ©p CS1 (admin) vÃ  chÃ­nh CS Ä‘Ã£ táº¡o sá»­a
    if (!isManagerRole(req.role) && !isMainPlant(req)) {
        const userPlantId = getUserPlantId(req);
        if (userPlantId !== toId(request.fromPlantId) && req.userId !== toId(request.requestedBy)) {
            throw new UnAuthorizedError('Ban khong co quyen cap nhat phieu nay');
        }
    }

    let nextItems = request.items;

    if (req.body.items) {
        const materialIds = req.body.items.map((item: any) => String(item.materialId));
        const materialsMap = await getMaterialsMap(materialIds);

        nextItems = req.body.items.map((item: any) => {
            const mat = materialsMap.get(String(item.materialId));
            if (!mat) throw new BadRequestError(`Khong tim thay vat tu: ${item.materialId}`);
            return {
                materialId: mat._id,
                materialName: mat.name,
                unit: mat.unit,
                quantityRequested: Number(item.quantityRequested),
                quantityApproved: item.quantityApproved !== undefined ? Number(item.quantityApproved) : undefined,
                note: item.note?.trim() || undefined,
            };
        }) as any;
    }

    const updated = await purchaseRequestRepository.updateById(String(req.params.id), {
        items: nextItems,
        note: req.body.note !== undefined ? req.body.note?.trim() || undefined : request.note,
        ...(req.body.requestDate !== undefined ? { requestDate: new Date(req.body.requestDate) } : {}),
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updated),
            message: 'Cap nhat phieu de xuat cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};


export const approveAndDistribute = async (req: Request, res: Response, next: NextFunction) => approveSupplyRequest(req, res, next);

export const rejectSupplyRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== 'supply_request') {
        throw new NotFoundError('Khong tim thay phieu de xuat cap vat tu');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the tu choi phieu dang cho duyet');
    }

    const updated = await purchaseRequestRepository.updateById(String(req.params.id), {
        status: 'rejected',
        approvedBy: req.userId,
        approvedAt: new Date(),
        rejectedReason: req.body.reason?.trim(),
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updated),
            message: 'Tu choi phieu de xuat cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};


export const exportSupplyRequestXlsx = async (req: Request, res: Response, next: NextFunction) => {
    const { generateSupplyRequestXlsx } = await import('@/utils/generateSupplyRequestXlsx');
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== 'supply_request') {
        throw new NotFoundError('Khong tim thay phieu de xuat cap vat tu');
    }

    const data = serializePurchaseRequest(request);
    const buffer = await generateSupplyRequestXlsx(data);
    const filename = `Phieu_De_Xuat_Cap_Vat_Tu_${data.requestCode ?? req.params.id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
};


export const approveSupplyRequest = async (req: Request, res: Response, next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== 'supply_request') {
        throw new NotFoundError('Khong tim thay phieu de xuat cap vat tu');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the duyet phieu dang cho duyet');
    }

    // Map materialId + quantityApproved vào từng item theo thứ tự
    const approvalItems: Array<{ materialId: string; quantityApproved: number }> = req.body.items ?? [];
    if (!approvalItems.length) {
        throw new BadRequestError('Phai cung cap thong tin duyet cho it nhat 1 vat tu');
    }

    const materialIds = approvalItems.map((i) => i.materialId);
    const materialsMap = await getMaterialsMap(materialIds);

    const updatedItems = (request.items as any[]).map((item: any, idx: number) => {
        const approval = approvalItems[idx];
        if (!approval) return item;
        const mat = materialsMap.get(String(approval.materialId));
        if (!mat) throw new BadRequestError(`Khong tim thay vat tu: ${approval.materialId}`);
        return {
            ...item.toObject ? item.toObject() : item,
            materialId: mat._id,
            quantityApproved: Number(approval.quantityApproved),
        };
    });

    const updated = await purchaseRequestRepository.updateById(String(req.params.id), {
        status: 'approved',
        approvedBy: req.userId,
        approvedAt: new Date(),
        items: updatedItems,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updated),
            message: 'Duyet phieu de xuat cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
