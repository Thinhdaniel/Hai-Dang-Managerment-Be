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
import { matchMaterialsForItems } from '@/services/material-match.helpers';
import { notifyAdmins, notifyUser, getActorName } from '@/services/notification.helper';
import { appendWorkflowSystemMessage } from '@/services/chat.service';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializePurchaseOrder, serializePurchaseRequest } from '@/utils/materialSerializers';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

/** Build items cho phép vật tư mới, nhưng tự khớp danh mục khi đủ chắc chắn. */
const buildFreeFormItems = async (rawItems: any[]) => {
    const matches = await matchMaterialsForItems(rawItems);

    return rawItems.map((item: any, index: number) => {
        const match = matches[index];
        if (item.materialId && match.reason === 'missing_explicit_id') {
            throw new BadRequestError(`Dong ${index + 1}: vat tu da chon khong ton tai hoac da ngung su dung`);
        }

        const matchedMaterial = match.status === 'matched' ? match.material : undefined;
        const qty = Number(item.quantityOrdered ?? item.quantityRequested ?? 0);
        const price = Number(item.unitPrice ?? 0);
        const totalPrice = Number((qty * price).toFixed(2));
        // FE gá»­i vatRate 0-100, normalize vá» 0-1
        const vatRateRaw = item.vatRate != null ? Number(item.vatRate) : 8;
        const vatRate = vatRateRaw > 1 ? vatRateRaw / 100 : vatRateRaw;
        const vatAmount = Number((totalPrice * vatRate).toFixed(2));
        const totalWithVat = Number((totalPrice + vatAmount).toFixed(2));

        return {
            materialId: matchedMaterial?._id || item.materialId || undefined,
            materialName: matchedMaterial?.name || item.materialName?.trim() || '',
            unit: matchedMaterial?.unit || item.unit?.trim() || '',
            proposedBy: item.proposedBy?.trim() || '',
            purpose: item.purpose?.trim() || '',
            plantId: item.plantId || undefined,
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
            catalogStatus:
                item.catalogStatus === 'ignored'
                    ? 'ignored'
                    : matchedMaterial
                      ? 'matched'
                      : item.catalogStatus || 'unmatched',
            estimatedPrice: item.estimatedPrice != null ? Number(item.estimatedPrice) : undefined,
            estimatedTotal: item.estimatedTotal != null ? Number(item.estimatedTotal) : undefined,
            note: item.note?.trim() || undefined,
            sourceTechnicalRequestId: item.sourceTechnicalRequestId || undefined,
            sourceTechnicalItemIndex:
                item.sourceTechnicalItemIndex != null ? Number(item.sourceTechnicalItemIndex) : undefined,
        };
    });
};

// ── Rổ vật tư kỹ thuật: dòng DX lấy nguồn từ phiếu KT đã duyệt ──────────────
// Trước khi tạo DX: xác thực dòng KT còn "trống" (chưa vào DX khác) + điền mã KT vào dòng DX.
const validateTechnicalSources = async (items: any[]) => {
    const refs = items
        .map((item, index) => ({
            index,
            requestId: item.sourceTechnicalRequestId ? String(item.sourceTechnicalRequestId) : '',
            itemIndex: item.sourceTechnicalItemIndex,
        }))
        .filter((ref) => ref.requestId && ref.itemIndex != null);
    if (!refs.length) return items;

    const ktDocs = await PurchaseRequest.find({
        _id: { $in: [...new Set(refs.map((ref) => ref.requestId))] },
        requestType: 'technical_purchase',
        isDeleted: { $ne: true },
    }).lean();
    const ktById = new Map(ktDocs.map((doc: any) => [String(doc._id), doc]));

    for (const ref of refs) {
        const kt: any = ktById.get(ref.requestId);
        if (!kt) throw new BadRequestError('Phieu ky thuat nguon khong ton tai');
        if (!['approved', 'in_progress'].includes(kt.status)) {
            throw new BadRequestError(`Phieu ${kt.requestCode} chua duoc duyet, khong the dua vao de xuat mua`);
        }
        const ktItem = kt.items?.[ref.itemIndex];
        if (!ktItem) throw new BadRequestError(`Dong vat tu nguon cua phieu ${kt.requestCode} khong ton tai`);
        if (ktItem.consumedByRequestId) {
            throw new BadRequestError(
                `"${ktItem.materialName}" cua phieu ${kt.requestCode} da nam trong de xuat ${ktItem.consumedByRequestCode || 'khac'}`
            );
        }
        items[ref.index].sourceTechnicalRequestCode = kt.requestCode;
    }
    return items;
};

// Sau khi tạo DX: đánh dấu dòng KT đã tiêu thụ, phiếu KT đủ dòng thì sang "đang xử lý mua",
// báo cho người kỹ thuật biết vật tư của mình đã được đưa vào đề xuất.
const consumeTechnicalSources = async (createdRequest: any, items: any[]) => {
    const refs = items
        .map((item) => ({
            requestId: item.sourceTechnicalRequestId ? String(item.sourceTechnicalRequestId) : '',
            itemIndex: item.sourceTechnicalItemIndex,
        }))
        .filter((ref) => ref.requestId && ref.itemIndex != null);
    if (!refs.length) return;

    const byRequest = new Map<string, number[]>();
    refs.forEach((ref) => byRequest.set(ref.requestId, [...(byRequest.get(ref.requestId) ?? []), ref.itemIndex]));

    for (const [ktId, itemIndexes] of byRequest) {
        const kt: any = await PurchaseRequest.findOne({
            _id: ktId,
            requestType: 'technical_purchase',
            isDeleted: { $ne: true },
        });
        if (!kt) continue;
        let changed = false;
        itemIndexes.forEach((itemIndex) => {
            const item = kt.items?.[itemIndex];
            if (item && !item.consumedByRequestId) {
                item.consumedByRequestId = createdRequest._id;
                item.consumedByRequestCode = createdRequest.requestCode;
                changed = true;
            }
        });
        if (!changed) continue;
        if (kt.status === 'approved' && (kt.items ?? []).every((item: any) => item.consumedByRequestId)) {
            kt.status = 'in_progress';
        }
        await kt.save();
        void notifyUser(String(kt.requestedBy), 'notify:new', {
            type: 'info',
            actionType: 'technical_purchase',
            actionId: String(kt._id),
            title: 'Vật tư đã vào đề xuất mua',
            message: `Vật tư trong phiếu ${kt.requestCode} đã được đưa vào đề xuất ${createdRequest.requestCode || ''}`,
        });
    }
};

const buildPurchaseRequestFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        // KT (kỹ thuật) đi đường riêng: duyệt xong vào rổ chờ, kéo vào DX qua form tạo — không hiện ở đây
        requestType: { $nin: ['supply_request', 'technical_purchase'] },
    };

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [
            { requestCode: regex },
            { note: regex },
            { 'items.materialName': regex },
            { 'items.supplierName': regex },
        ];
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

    if (req.role !== 'admin') {
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

    if (req.role !== 'admin') {
        const userPlantId = getUserPlantId(req);
        if (!userPlantId || userPlantId !== resolvedPlantId) {
            throw new UnAuthorizedError('Ban chi co the tao phieu mua cho co so cua minh');
        }
    } else {
        assertPlantAccess(req, resolvedPlantId);
    }
    await ensurePlantExists(resolvedPlantId);

    return resolvedPlantId;
};

const buildApprovalItems = async (request: any, overrideItems?: any[]) => {
    // Với free-form items (không có materialId), chỉ cần giữ nguyên items hiện tại
    // và cập nhật quantityApproved nếu có override
    const plainItems = (request.items ?? []).map((item: any) =>
        typeof item.toObject === 'function' ? item.toObject() : item
    );
    const matches = await matchMaterialsForItems(plainItems);
    const items = plainItems.map((plainItem: any, idx: number) => {
        const override = overrideItems?.[idx];
        const matchedMaterial = matches[idx]?.status === 'matched' ? matches[idx].material : undefined;
        return {
            ...plainItem,
            materialId: matchedMaterial?._id || plainItem.materialId,
            materialName: matchedMaterial?.name || plainItem.materialName,
            unit: matchedMaterial?.unit || plainItem.unit,
            catalogStatus:
                plainItem.catalogStatus === 'ignored'
                    ? 'ignored'
                    : matchedMaterial
                      ? 'matched'
                      : plainItem.catalogStatus || (plainItem.materialId ? 'matched' : 'unmatched'),
            quantityApproved: override?.quantityApproved ?? plainItem.quantityRequested,
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
    const requestMonth = req.body.requestMonth ?? now.getMonth() + 1;
    const requestYear = req.body.requestYear ?? now.getFullYear();

    const items = await validateTechnicalSources(await buildFreeFormItems(req.body.items));
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

    // Đánh dấu các dòng kéo từ rổ kỹ thuật + báo người đề nghị
    await consumeTechnicalSources(
        { _id: request._id, requestCode: (createdRequest as any)?.requestCode },
        items
    );

    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'info',
            actionType: 'purchase_request',
            actionId: String(request._id),
            title: 'Phiếu đề xuất mua vật tư mới',
            message: `${actorName} đã tạo phiếu đề xuất ${(createdRequest as any)?.requestCode || ''}`,
        },
        { excludeUserIds: [req.userId] }
    );

    // Phiếu nháp chưa gửi duyệt thì chưa mở thread trao đổi
    if ((createdRequest as any)?.status !== 'draft') {
        void appendWorkflowSystemMessage(
            'purchase_request',
            String(request._id),
            `${actorName} đã tạo phiếu đề xuất mua vật tư ${(createdRequest as any)?.requestCode || ''}.`,
            req.userId
        );
    }

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

    const plantId = req.body.plantId
        ? await resolvePurchaseRequestPlantId(req, req.body.plantId)
        : toId(request.plantId);
    const nextNote = req.body.note !== undefined ? req.body.note?.trim() || undefined : request.note;
    let nextItems: any = request.items;
    let totalEstimated = Number(request.totalEstimated ?? 0);
    let totalWithVat = Number((request as any).totalWithVat ?? 0);

    if (req.body.items) {
        nextItems = await buildFreeFormItems(req.body.items);
        totalEstimated = Number(
            nextItems.reduce((s: number, i: any) => s + (i.totalPrice ?? i.estimatedTotal ?? 0), 0).toFixed(2)
        );
        totalWithVat = Number(nextItems.reduce((s: number, i: any) => s + (i.totalWithVat ?? 0), 0).toFixed(2));
    }

    const patch: Record<string, any> = { plantId, items: nextItems, totalEstimated, totalWithVat, note: nextNote };
    if (req.body.status) patch.status = req.body.status;
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

    const actorName = await getActorName(req.userId);
    await notifyUser(toId(request.requestedBy)!, 'notify:new', {
        type: 'success',
        actionType: 'purchase_request',
        actionId: String(req.params.id),
        title: 'Phiếu đề xuất được duyệt',
        message: `${actorName} đã duyệt phiếu ${(request as any).requestCode || ''}`,
    });

    void appendWorkflowSystemMessage(
        'purchase_request',
        String(req.params.id),
        `${actorName} đã duyệt phiếu đề xuất ${(request as any).requestCode || ''}.`,
        req.userId
    );

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

    const actorName = await getActorName(req.userId);
    await notifyUser(toId(request.requestedBy)!, 'notify:new', {
        type: 'error',
        actionType: 'purchase_request',
        actionId: String(req.params.id),
        title: 'Phiếu đề xuất bị từ chối',
        message: `${actorName} đã từ chối phiếu ${(request as any).requestCode || ''}${req.body.reason ? ': ' + req.body.reason : ''}`,
    });

    void appendWorkflowSystemMessage(
        'purchase_request',
        String(req.params.id),
        `${actorName} đã từ chối phiếu đề xuất ${(request as any).requestCode || ''}.${req.body.reason ? ` Lý do: ${req.body.reason}` : ''}`,
        req.userId
    );

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

            const technicalRequests = requests.filter(
                (request) => (request as any).requestType === 'technical_purchase'
            );
            if (technicalRequests.length) {
                throw new BadRequestError('Phieu ky thuat khong len don truc tiep — hay keo vao de xuat mua truoc');
            }

            const invalidRequests = requests.filter((request) => request.status !== 'approved');

            if (invalidRequests.length) {
                throw new BadRequestError('Chi co the tong hop cac phieu de xuat da duyet');
            }

            // Cơ sở của phiếu tính theo dòng vật tư (fallback header) — header là cơ sở người tạo,
            // có thể khác cơ sở nhận hàng khi tạo phiếu mua hộ cơ sở khác.
            const isValidPlantRef = (v: any) => v && v !== 'undefined' && v !== 'null' && String(v).length === 24;
            const requestPlantIds = [
                ...new Set<string>(
                    requests.flatMap((request): string[] => {
                        const headerId = String((request as any).plantId?._id ?? (request as any).plantId ?? '');
                        const ids = ((request as any).items ?? [])
                            .map((i: any) => (isValidPlantRef(i.plantId) ? String(i.plantId) : headerId))
                            .filter(Boolean);
                        return [...new Set<string>(ids.length ? ids : headerId ? [headerId] : [])];
                    })
                ),
            ];
            if (requestPlantIds.length !== 1) {
                throw new BadRequestError('Chi co the tong hop cac phieu cung mot co so');
            }
            const orderPlantId = requestPlantIds[0];
            await ensurePlantExists(orderPlantId, session);
            if (req.role !== 'admin' && getUserPlantId(req) !== orderPlantId) {
                throw new BadRequestError('Ban chi co the tao don hang cho co so cua minh');
            }

            const resolvedSupplierId = ensureSingleSupplierForItems(
                requests,
                req.body.supplierId ? String(req.body.supplierId) : undefined
            );
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
                {
                    materialId: string;
                    unit?: string;
                    quantity: number;
                    unitPrice?: number;
                    note?: string;
                    sourceLines?: any[];
                }
            >();

            requests.forEach((request) => {
                (request.items ?? []).forEach((item: any, itemIndex: number) => {
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
                    const sourceLine = {
                        purchaseRequestId: (request as any)._id,
                        purchaseRequestCode: (request as any).requestCode,
                        requestItemIndex: itemIndex,
                        materialId: item.materialId,
                        materialName: item.materialName,
                        unit: item.unit,
                        plantId: item.plantId || (request as any).plantId,
                        proposedBy: item.proposedBy,
                        purpose: item.purpose,
                        quantityRequested: Number(item.quantityRequested ?? 0),
                        quantityOrdered: quantity,
                    };

                    if (currentEntry) {
                        currentEntry.quantity += quantity;
                        currentEntry.sourceLines = [...(currentEntry.sourceLines ?? []), sourceLine];
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
                            sourceLines: [sourceLine],
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
                    plantId: orderPlantId,
                    supplierId: supplier?._id,
                    supplierName: supplier?.name,
                    purchaseRequestIds: requests.map((request) => request._id),
                    purchaseRequestCodes: requests.map((request) => (request as any).requestCode).filter(Boolean),
                    status: 'draft',
                    items: preparedItems.items,
                    totalAmount: preparedItems.totalAmount,
                    totalVat: preparedItems.totalVat,
                    totalWithVat: preparedItems.totalWithVat,
                    createdBy: req.userId,
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
                    status: 'in_progress',
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
    res.send(Buffer.from(buffer));
};
