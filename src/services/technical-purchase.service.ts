import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import PurchaseRequest from '@/models/PurchaseRequest';
import { purchaseRequestRepository } from '@/repositories/purchase-request.repository';
import { generateDocumentCode, getUserPlantId, isManagerRole, toId } from '@/services/material-workflow.helpers';
import { getActorName, notifyAdmins, notifyUser } from '@/services/notification.helper';
import { appendWorkflowSystemMessage } from '@/services/chat.service';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializePurchaseRequest } from '@/utils/materialSerializers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const REQUEST_TYPE = 'technical_purchase';
const DEFAULT_DEPARTMENT = 'Kỹ thuật';

// Chuẩn hoá items + snapshot mã/tên máy tại thời điểm tạo (máy đổi tên sau này phiếu vẫn đúng)
const buildTechnicalItems = async (rawItems: any[]) => {
    const Asset = (await import('@/models/Asset')).default;
    const assetIds = [...new Set(rawItems.map((item) => item.assetId).filter(Boolean).map(String))];
    const assets = assetIds.length
        ? await Asset.find({ _id: { $in: assetIds }, isDeleted: { $ne: true } })
              .select('machineCode name')
              .lean()
        : [];
    const assetById = new Map(assets.map((asset: any) => [String(asset._id), asset]));

    return rawItems.map((item: any) => {
        const asset: any = item.assetId ? assetById.get(String(item.assetId)) : undefined;
        return {
            materialName: item.materialName?.trim(),
            unit: item.unit?.trim(),
            quantityRequested: Number(item.quantityRequested),
            note: item.note?.trim() || undefined,
            assetId: asset?._id,
            assetCode: asset?.machineCode,
            assetName: asset?.name,
            imageUrls: item.imageUrls?.length ? item.imageUrls : undefined,
        };
    });
};

// Gợi ý tên vật tư: ưu tiên đồ đã mua trong các phiếu KT (đúng thói quen gọi tên
// của kỹ thuật), bổ sung từ danh mục vật tư. Không ép khớp — chỉ là autocomplete.
export const getTechnicalMaterialSuggestions = async (req: Request, res: Response, _next: NextFunction) => {
    const regex = buildSearchRegex(req.query.search, { flexibleWhitespace: true });
    const Material = (await import('@/models/Material')).default;

    const [historyRows, catalogRows] = await Promise.all([
        PurchaseRequest.aggregate([
            { $match: { requestType: REQUEST_TYPE, isDeleted: { $ne: true } } },
            { $unwind: '$items' },
            { $match: { 'items.materialName': regex ?? { $type: 'string', $ne: '' } } },
            { $sort: { createdAt: 1 } },
            {
                $group: {
                    _id: { $toLower: { $trim: { input: '$items.materialName' } } },
                    name: { $last: '$items.materialName' },
                    unit: { $last: '$items.unit' },
                    count: { $sum: 1 },
                    lastUsedAt: { $max: '$createdAt' },
                },
            },
            { $sort: { lastUsedAt: -1 } },
            { $limit: 8 },
        ]),
        Material.find({
            isDeleted: { $ne: true },
            isActive: { $ne: false },
            ...(regex ? { name: regex } : {}),
        })
            .select('name unit')
            .sort('name')
            .limit(8)
            .lean(),
    ]);

    const seen = new Set<string>();
    const suggestions: Array<{ name: string; unit?: string; source: 'history' | 'catalog'; count?: number }> = [];
    for (const row of historyRows as any[]) {
        const key = String(row._id);
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ name: row.name, unit: row.unit || undefined, source: 'history', count: row.count });
    }
    for (const row of catalogRows as any[]) {
        const key = String(row.name ?? '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ name: row.name, unit: row.unit || undefined, source: 'catalog' });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: suggestions.slice(0, 12),
            message: 'Lay goi y vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const buildFilter = (query: Request['query'], req: Request) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        requestType: REQUEST_TYPE,
    };

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });
    if (regex) {
        filter.$or = [
            { requestCode: regex },
            { note: regex },
            { requesterName: regex },
            { department: regex },
            { 'items.materialName': regex },
        ];
    }

    if (query.status) filter.status = query.status;
    if (query.requestedBy) filter.requestedBy = query.requestedBy;
    if (query.plantId) filter.plantId = query.plantId;

    if (query.startDate || query.endDate) {
        filter.createdAt = {};
        if (query.startDate) filter.createdAt.$gte = new Date(String(query.startDate));
        if (query.endDate) {
            const endDate = new Date(String(query.endDate));
            endDate.setHours(23, 59, 59, 999);
            filter.createdAt.$lte = endDate;
        }
    }

    // Quản lý trở lên xem tất cả; người khác (bộ phận kỹ thuật) chỉ xem phiếu của mình
    if (!isManagerRole(req.role)) {
        filter.requestedBy = req.userId;
    }

    return filter;
};

export const getAllTechnicalPurchaseRequests = async (req: Request, res: Response, _next: NextFunction) => {
    const filter = buildFilter(req.query, req);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const sort = String(req.query.sort || '-createdAt').split(',').join(' ');

    const [requests, total] = await Promise.all([
        purchaseRequestRepository.findMany(filter, { sort, skip, limit }),
        purchaseRequestRepository.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(requests.map(serializePurchaseRequest), total, page, limit),
            message: 'Lay danh sach giay de nghi mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getTechnicalPurchaseRequestById = async (req: Request, res: Response, _next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== REQUEST_TYPE) {
        throw new NotFoundError('Khong tim thay giay de nghi mua vat tu');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(request),
            message: 'Lay chi tiet giay de nghi mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createTechnicalPurchaseRequest = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = getUserPlantId(req) || process.env.MAIN_PLANT_ID;
    if (!plantId) throw new BadRequestError('Nguoi dung chua duoc gan co so');

    const actorName = await getActorName(req.userId);

    const requestCode = await generateDocumentCode({
        model: PurchaseRequest,
        field: 'requestCode',
        prefix: 'KT',
    });

    const items = await buildTechnicalItems(req.body.items);

    const request = await purchaseRequestRepository.create({
        requestCode,
        requestType: REQUEST_TYPE,
        plantId,
        requestedBy: req.userId,
        requesterName: req.body.requesterName?.trim() || actorName,
        department: req.body.department?.trim() || DEFAULT_DEPARTMENT,
        status: 'pending',
        items,
        totalEstimated: 0,
        totalActual: 0,
        note: req.body.note?.trim() || undefined,
        requestDate: req.body.requestDate ? new Date(req.body.requestDate) : new Date(),
    });

    const created = await purchaseRequestRepository.findById(String(request._id));

    await notifyAdmins(
        'notify:new',
        {
            type: 'info',
            actionType: 'technical_purchase',
            actionId: String(request._id),
            title: 'Giấy đề nghị mua vật tư mới',
            message: `${actorName} đã tạo giấy đề nghị mua vật tư ${(created as any)?.requestCode || ''}`,
        },
        { excludeUserIds: [req.userId] }
    );

    void appendWorkflowSystemMessage(
        'technical_purchase',
        String(request._id),
        `${actorName} đã tạo giấy đề nghị mua vật tư ${(created as any)?.requestCode || ''}.`,
        req.userId
    );

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializePurchaseRequest(created),
            message: 'Tao giay de nghi mua vat tu thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updateTechnicalPurchaseRequest = async (req: Request, res: Response, _next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== REQUEST_TYPE) {
        throw new NotFoundError('Khong tim thay giay de nghi mua vat tu');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the cap nhat phieu dang cho duyet');
    }

    // Chủ phiếu hoặc quản lý mới được sửa
    if (!isManagerRole(req.role) && req.userId !== toId(request.requestedBy)) {
        throw new UnAuthorizedError('Ban khong co quyen cap nhat phieu nay');
    }

    let nextItems = request.items;
    if (req.body.items) {
        nextItems = (await buildTechnicalItems(req.body.items)) as any;
    }

    const update: Record<string, unknown> = {
        items: nextItems,
        note: req.body.note !== undefined ? req.body.note?.trim() || undefined : request.note,
        ...(req.body.requestDate !== undefined ? { requestDate: new Date(req.body.requestDate) } : {}),
    };
    if (req.body.requesterName !== undefined) update.requesterName = req.body.requesterName?.trim() || undefined;
    if (req.body.department !== undefined) update.department = req.body.department?.trim() || DEFAULT_DEPARTMENT;

    const updated = await purchaseRequestRepository.updateById(String(req.params.id), update);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updated),
            message: 'Cap nhat giay de nghi mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const approveTechnicalPurchaseRequest = async (req: Request, res: Response, _next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== REQUEST_TYPE) {
        throw new NotFoundError('Khong tim thay giay de nghi mua vat tu');
    }

    if (request.status !== 'pending') {
        throw new BadRequestError('Chi co the duyet phieu dang cho duyet');
    }

    const approvalItems: Array<{ quantityApproved: number }> = req.body.items ?? [];
    const updatedItems = (request.items as any[]).map((item: any, idx: number) => {
        const approval = approvalItems[idx];
        const base = item.toObject ? item.toObject() : item;
        return {
            ...base,
            quantityApproved: approval ? Number(approval.quantityApproved) : base.quantityApproved ?? base.quantityRequested,
        };
    });

    const updated = await purchaseRequestRepository.updateById(String(req.params.id), {
        status: 'approved',
        approvedBy: req.userId,
        approvedAt: new Date(),
        items: updatedItems,
    });

    const actorName = await getActorName(req.userId);
    await notifyUser(toId(request.requestedBy)!, 'notify:new', {
        type: 'success',
        actionType: 'technical_purchase',
        actionId: String(req.params.id),
        title: 'Giấy đề nghị mua vật tư được duyệt',
        message: `${actorName} đã duyệt phiếu ${(request as any).requestCode || ''}`,
    });

    void appendWorkflowSystemMessage(
        'technical_purchase',
        String(req.params.id),
        `${actorName} đã duyệt giấy đề nghị mua vật tư ${(request as any).requestCode || ''}.`,
        req.userId
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updated),
            message: 'Duyet giay de nghi mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const rejectTechnicalPurchaseRequest = async (req: Request, res: Response, _next: NextFunction) => {
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== REQUEST_TYPE) {
        throw new NotFoundError('Khong tim thay giay de nghi mua vat tu');
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

    const actorName = await getActorName(req.userId);
    await notifyUser(toId(request.requestedBy)!, 'notify:new', {
        type: 'error',
        actionType: 'technical_purchase',
        actionId: String(req.params.id),
        title: 'Giấy đề nghị mua vật tư bị từ chối',
        message: `${actorName} đã từ chối phiếu ${(request as any).requestCode || ''}${req.body.reason ? ': ' + req.body.reason : ''}`,
    });

    void appendWorkflowSystemMessage(
        'technical_purchase',
        String(req.params.id),
        `${actorName} đã từ chối giấy đề nghị mua vật tư ${(request as any).requestCode || ''}.${req.body.reason ? ` Lý do: ${req.body.reason}` : ''}`,
        req.userId
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializePurchaseRequest(updated),
            message: 'Tu choi giay de nghi mua vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportTechnicalPurchaseRequestXlsx = async (req: Request, res: Response, _next: NextFunction) => {
    const { generateTechnicalPurchaseRequestXlsx } = await import('@/utils/generateTechnicalPurchaseRequestXlsx');
    const request = await purchaseRequestRepository.findById(String(req.params.id));

    if (!request || (request as any).requestType !== REQUEST_TYPE) {
        throw new NotFoundError('Khong tim thay giay de nghi mua vat tu');
    }

    const data = serializePurchaseRequest(request);
    const buffer = await generateTechnicalPurchaseRequestXlsx(data);
    const filename = `Giay_De_Nghi_Mua_Vat_Tu_${data.requestCode ?? req.params.id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
};
