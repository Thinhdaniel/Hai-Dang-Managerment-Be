import {
    ASSET_DISPOSAL_BATCH_STATUS,
    ASSET_DISPOSAL_ITEM_STATUS,
    ASSET_DISPOSAL_SOURCE_TYPE,
} from '@/constant/assetDisposal';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { QR_LABEL_STATUS } from '@/constant/qrLabel';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import { emitToAll } from '@/lib/socket';
import Asset from '@/models/Asset';
import AssetDisposalBatch from '@/models/AssetDisposalBatch';
import AssetDisposalItem from '@/models/AssetDisposalItem';
import QrLabel from '@/models/QrLabel';
import { generateAssetDisposalXlsx } from '@/utils/generateAssetDisposalXlsx';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { serializeAsset, serializeAssetDisposalBatch, serializeAssetDisposalItem } from '@/utils/serializers';
import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const FINAL_BATCH_STATUSES = [ASSET_DISPOSAL_BATCH_STATUS.COMPLETED, ASSET_DISPOSAL_BATCH_STATUS.CANCELLED];
const FINAL_ITEM_STATUSES = [
    ASSET_DISPOSAL_ITEM_STATUS.DISPOSED,
    ASSET_DISPOSAL_ITEM_STATUS.KEPT,
    ASSET_DISPOSAL_ITEM_STATUS.CANCELLED,
];
const ASSET_DISPOSAL_BLOCKED_STATUSES = [
    ASSET_STATUS.PENDING_DISPOSAL,
    ASSET_STATUS.DISPOSED,
    ASSET_STATUS.RETURNED_TO_PARTNER,
];

const BATCH_POPULATE = ['plantId', 'submittedBy', 'approvedBy', 'completedBy', 'cancelledBy', 'createdBy', 'updatedBy'];
const ITEM_POPULATE = [
    { path: 'assetId', populate: ['brandId', 'plantId'] },
    'plantId',
    'qrLabelId',
    'checkedBy',
    'createdBy',
    'updatedBy',
];

const toId = (value: any) => String(value?._id ?? value?.id ?? value ?? '');
const trim = (value?: string | null) => value?.trim() || undefined;
const normalizePublicId = (value: string) => value.trim().toUpperCase();
const idsEqual = (a: any, b: any) => {
    const left = toId(a);
    const right = toId(b);
    return Boolean(left && right && left === right);
};
const getBatchPlantId = (batch: any) => batch?.plantId?._id ?? batch?.plantId;
const getPlantName = (value: any) => value?.name || value?.code || toId(value) || 'khong ro co so';

const getParamValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

const extractPublicId = (rawValue: string) => {
    const value = rawValue.trim();
    try {
        const url = new URL(value);
        const segments = url.pathname.split('/').filter(Boolean);
        const anchorIndex = segments.findIndex((segment) => segment === 'machines' || segment === 'qr');
        const candidate = anchorIndex >= 0 ? segments[anchorIndex + 1] : segments[segments.length - 1];
        if (candidate) return normalizePublicId(candidate);
    } catch {
        // raw QR token or manual input
    }
    return normalizePublicId(value);
};

const applyPopulate = (query: any, populate: readonly any[]) =>
    populate.reduce((current, item) => current.populate(item), query);

const broadcastAssetChange = (asset: unknown, action: string, changedFields: string[] = []) => {
    if (!asset) return;
    const serializedAsset = serializeAsset(asset);
    emitToAll('asset:updated', {
        action,
        assetId: serializedAsset.id,
        asset: serializedAsset,
        changedFields,
        updatedAt: serializedAsset.updatedAt ?? new Date().toISOString(),
    });
};

const buildBatchFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    if (query.status) filter.status = query.status;
    if (query.plantId) filter.plantId = query.plantId;

    if (query.search) {
        const regex = new RegExp(String(query.search).trim(), 'i');
        filter.$or = [{ code: regex }, { reason: regex }, { area: regex }, { note: regex }];
    }

    return filter;
};

const createUniqueBatchCode = async () => {
    const date = new Date();
    const prefix = `TL-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;

    for (let i = 0; i < 20; i += 1) {
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
        const code = `${prefix}-${suffix}`;
        const exists = await AssetDisposalBatch.exists({ code });
        if (!exists) return code;
    }

    throw new Error('Unable to generate disposal batch code');
};

const decorateBatchCounts = async (batches: any[]) => {
    if (!batches.length) return batches;
    const batchIds = batches.map((batch) => batch._id);
    const rows = await AssetDisposalItem.aggregate([
        { $match: { batchId: { $in: batchIds }, isDeleted: { $ne: true } } },
        {
            $group: {
                _id: '$batchId',
                totalItems: { $sum: 1 },
                assetItems: {
                    $sum: { $cond: [{ $eq: ['$sourceType', ASSET_DISPOSAL_SOURCE_TYPE.ASSET] }, 1, 0] },
                },
                externalItems: {
                    $sum: {
                        $cond: [
                            {
                                $in: [
                                    '$sourceType',
                                    [ASSET_DISPOSAL_SOURCE_TYPE.EXTERNAL, ASSET_DISPOSAL_SOURCE_TYPE.QR_ONLY],
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                pendingItems: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_DISPOSAL_ITEM_STATUS.PENDING] }, 1, 0] },
                },
                checkedItems: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_DISPOSAL_ITEM_STATUS.CHECKED] }, 1, 0] },
                },
                approvedItems: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_DISPOSAL_ITEM_STATUS.APPROVED] }, 1, 0] },
                },
                disposedItems: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_DISPOSAL_ITEM_STATUS.DISPOSED] }, 1, 0] },
                },
                keptItems: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_DISPOSAL_ITEM_STATUS.KEPT] }, 1, 0] },
                },
            },
        },
    ]);

    const byId = new Map(rows.map((row: any) => [String(row._id), row]));
    return batches.map((batch) => {
        const counts = byId.get(String(batch._id)) ?? {};
        return Object.assign(batch, {
            totalItems: counts.totalItems ?? 0,
            assetItems: counts.assetItems ?? 0,
            externalItems: counts.externalItems ?? 0,
            pendingItems: counts.pendingItems ?? 0,
            checkedItems: counts.checkedItems ?? 0,
            approvedItems: counts.approvedItems ?? 0,
            disposedItems: counts.disposedItems ?? 0,
            keptItems: counts.keptItems ?? 0,
        });
    });
};

const getBatchOrThrow = async (id: string) => {
    const batch = await applyPopulate(
        AssetDisposalBatch.findOne({ _id: id, isDeleted: { $ne: true } }),
        BATCH_POPULATE
    );
    if (!batch) throw new NotFoundError('Khong tim thay dot thanh ly');
    return batch;
};

const assertBatchEditable = (batch: any) => {
    if (FINAL_BATCH_STATUSES.includes(batch.status)) {
        throw new BadRequestError('Dot thanh ly da ket thuc, khong the cap nhat');
    }
    if (batch.status === ASSET_DISPOSAL_BATCH_STATUS.APPROVED) {
        throw new BadRequestError('Dot thanh ly da duoc duyet, khong the them hoac sua dong');
    }
};

const findOpenItemByAssetId = (assetId: string, excludeBatchId?: string) => {
    const filter: Record<string, any> = {
        assetId,
        isDeleted: { $ne: true },
        status: { $nin: FINAL_ITEM_STATUSES },
    };
    if (excludeBatchId) filter.batchId = { $ne: excludeBatchId };
    return AssetDisposalItem.findOne(filter).populate('batchId');
};

const findAssetByScanCandidate = async (candidate: string) => {
    const regex = new RegExp(`^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    return Asset.findOne({
        isDeleted: { $ne: true },
        $or: [{ publicId: candidate }, { machineCode: regex }, { serial: regex }],
    })
        .populate('brandId')
        .populate('plantId');
};

const findAssetByManualIdentity = async (payload: Record<string, any>) => {
    const candidates = [payload.publicId, payload.machineCode, payload.serial]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);

    for (const candidate of candidates) {
        const asset = await findAssetByScanCandidate(candidate);
        if (asset) return asset;
    }

    return null;
};

const assertAssetBelongsToBatchPlant = (asset: any, batch: any) => {
    if (idsEqual(asset.plantId?._id ?? asset.plantId, getBatchPlantId(batch))) return;
    throw new BadRequestError(
        `May ${asset.machineCode || asset.name || ''} thuoc ${getPlantName(
            asset.plantId
        )}, khong the dua vao lo thanh ly cua ${getPlantName(batch.plantId)}`
    );
};

const assertPublicIdAvailableForBatch = async (publicId?: string, batchId?: string, excludeItemId?: string) => {
    if (!publicId) return;
    const filter: Record<string, any> = {
        publicId,
        isDeleted: { $ne: true },
        status: { $nin: FINAL_ITEM_STATUSES },
    };
    if (batchId) filter.batchId = { $ne: batchId };
    if (excludeItemId) filter._id = { $ne: excludeItemId };

    const item = await AssetDisposalItem.findOne(filter).populate('batchId');
    if (!item) return;

    const openBatch = (item as any).batchId;
    throw new DuplicateError(`QR nay dang nam trong dot thanh ly ${openBatch?.code || toId(openBatch)}`);
};

const buildAssetItemPayload = (asset: any, batch: any, req: Request, overrides: Record<string, any> = {}) => ({
    batchId: batch._id,
    sourceType: ASSET_DISPOSAL_SOURCE_TYPE.ASSET,
    assetId: asset._id,
    publicId: asset.publicId,
    machineCode: asset.machineCode,
    name: asset.name,
    type: asset.type,
    model: asset.model ?? asset.type,
    serial: asset.serial,
    plantId: asset.plantId?._id ?? asset.plantId,
    area: asset.area,
    previousAssetStatus: asset.status,
    status: ASSET_DISPOSAL_ITEM_STATUS.CHECKED,
    checkedBy: req.userId,
    checkedAt: new Date(),
    reason: trim(overrides.reason) ?? trim(batch.reason),
    condition: overrides.condition,
    suggestedAction: overrides.suggestedAction,
    estimatedValue: overrides.estimatedValue,
    note: trim(overrides.note),
    photos: overrides.photos ?? [],
    createdBy: req.userId,
    updatedBy: req.userId,
});

const addAssetToBatch = async (asset: any, batch: any, req: Request, overrides: Record<string, any> = {}) => {
    if (asset.ownershipType && asset.ownershipType !== ASSET_OWNERSHIP_TYPE.OWNED) {
        throw new BadRequestError('May muon/thue khong duoc dua vao quy trinh thanh ly tai san cong ty');
    }
    assertAssetBelongsToBatchPlant(asset, batch);
    if (asset.status === ASSET_STATUS.DISPOSED || asset.status === ASSET_STATUS.RETURNED_TO_PARTNER) {
        throw new BadRequestError('May da dong vong doi, khong the dua vao dot thanh ly moi');
    }

    const existingInBatch = await AssetDisposalItem.findOne({
        batchId: batch._id,
        assetId: asset._id,
        isDeleted: { $ne: true },
    });
    if (existingInBatch) {
        return { item: await populateItem(existingInBatch._id), duplicate: true };
    }

    if (asset.status === ASSET_STATUS.PENDING_DISPOSAL) {
        const openItem = await findOpenItemByAssetId(String(asset._id), String(batch._id));
        const openBatch = (openItem as any)?.batchId;
        throw new DuplicateError(
            openBatch?.code
                ? `May nay dang nam trong dot thanh ly ${openBatch.code}`
                : 'May nay dang o trang thai chuan bi thanh ly, khong the dua vao dot moi'
        );
    }

    const openItem = await findOpenItemByAssetId(String(asset._id), String(batch._id));
    if (openItem) {
        const openBatch = (openItem as any).batchId;
        throw new DuplicateError(
            `May nay dang nam trong dot thanh ly ${openBatch?.code || String(openBatch?._id || '')}`
        );
    }

    const item = await AssetDisposalItem.create(buildAssetItemPayload(asset, batch, req, overrides));

    if (asset.status !== ASSET_STATUS.PENDING_DISPOSAL) {
        const updatedAsset = await Asset.findByIdAndUpdate(
            asset._id,
            { status: ASSET_STATUS.PENDING_DISPOSAL, statusNote: trim(overrides.note), updatedBy: req.userId },
            { returnDocument: 'after' }
        )
            .populate('brandId')
            .populate('plantId');
        broadcastAssetChange(updatedAsset, 'disposal-pending', ['status', 'statusNote']);
    }

    return { item: await populateItem(item._id), duplicate: false };
};

const validateBatchItemsBeforeWorkflow = async (batch: any) => {
    const items = await applyPopulate(
        AssetDisposalItem.find({
            batchId: batch._id,
            isDeleted: { $ne: true },
            status: { $nin: [ASSET_DISPOSAL_ITEM_STATUS.CANCELLED, ASSET_DISPOSAL_ITEM_STATUS.KEPT] },
        }),
        ITEM_POPULATE
    );

    if (!items.length) throw new BadRequestError('Dot thanh ly chua co may nao');

    for (const item of items as any[]) {
        if (item.assetId) {
            assertAssetBelongsToBatchPlant(item.assetId, batch);
        } else if (!idsEqual(item.plantId?._id ?? item.plantId, getBatchPlantId(batch))) {
            throw new BadRequestError(
                `Dong ${item.machineCode || item.publicId || item.name || ''} khong thuoc co so cua lo thanh ly`
            );
        }

        const codeOrQr = trim(item.machineCode) || trim(item.publicId);
        const name = trim(item.name) || item.assetId?.name;
        if (!codeOrQr && !name) {
            throw new BadRequestError('Moi dong thanh ly can co ma may/QR hoac ten may');
        }
        if (!item.condition || item.condition === 'unknown') {
            throw new BadRequestError(`Dong ${codeOrQr || name} chua co tinh trang ra soat`);
        }
        if (!item.suggestedAction || item.suggestedAction === 'unknown') {
            throw new BadRequestError(`Dong ${codeOrQr || name} chua co de xuat xu ly`);
        }
        if (!trim(item.reason) && !trim(batch.reason)) {
            throw new BadRequestError(`Dong ${codeOrQr || name} chua co ly do/ghi nhan`);
        }
    }
};

const populateItem = (id: any) =>
    applyPopulate(AssetDisposalItem.findOne({ _id: id, isDeleted: { $ne: true } }), ITEM_POPULATE);

const revertAssetIfNeeded = async (item: any, req: Request) => {
    const assetId = toId(item.assetId);
    if (!assetId) return;

    const nextStatus = item.previousAssetStatus || ASSET_STATUS.ACTIVE;
    const updatedAsset = await Asset.findOneAndUpdate(
        { _id: assetId, isDeleted: { $ne: true }, status: ASSET_STATUS.PENDING_DISPOSAL },
        { status: nextStatus, updatedBy: req.userId },
        { returnDocument: 'after' }
    )
        .populate('brandId')
        .populate('plantId');

    broadcastAssetChange(updatedAsset, 'disposal-reverted', ['status']);
};

const retireQrForItem = async (item: any, req: Request, reason: string) => {
    const asset = item.assetId && typeof item.assetId === 'object' ? item.assetId : undefined;
    const publicIds = [item.publicId, asset?.publicId].filter(Boolean);
    const orConditions: Record<string, unknown>[] = [];

    if (item.qrLabelId) orConditions.push({ _id: item.qrLabelId });
    if (asset?._id) orConditions.push({ assetId: asset._id });
    if (publicIds.length) orConditions.push({ publicId: { $in: publicIds } });

    if (!orConditions.length) return;

    await QrLabel.updateMany(
        {
            isDeleted: { $ne: true },
            status: { $nin: [QR_LABEL_STATUS.RETIRED, QR_LABEL_STATUS.LOST, QR_LABEL_STATUS.DAMAGED] },
            $or: orConditions,
        },
        {
            status: QR_LABEL_STATUS.RETIRED,
            retiredAt: new Date(),
            retiredBy: req.userId,
            retiredReason: reason,
            updatedBy: req.userId,
        }
    );
};

const buildDetail = async (batchId: string) => {
    const batch = await getBatchOrThrow(batchId);
    const [decoratedBatch] = await decorateBatchCounts([batch]);
    const items = await applyPopulate(
        AssetDisposalItem.find({ batchId, isDeleted: { $ne: true } }).sort('-createdAt'),
        ITEM_POPULATE
    );

    const summary = {
        total: items.length,
        asset: items.filter((item: any) => item.sourceType === ASSET_DISPOSAL_SOURCE_TYPE.ASSET).length,
        external: items.filter((item: any) => item.sourceType !== ASSET_DISPOSAL_SOURCE_TYPE.ASSET).length,
        pending: items.filter((item: any) => item.status === ASSET_DISPOSAL_ITEM_STATUS.PENDING).length,
        checked: items.filter((item: any) => item.status === ASSET_DISPOSAL_ITEM_STATUS.CHECKED).length,
        approved: items.filter((item: any) => item.status === ASSET_DISPOSAL_ITEM_STATUS.APPROVED).length,
        disposed: items.filter((item: any) => item.status === ASSET_DISPOSAL_ITEM_STATUS.DISPOSED).length,
        kept: items.filter((item: any) => item.status === ASSET_DISPOSAL_ITEM_STATUS.KEPT).length,
    };

    return {
        batch: serializeAssetDisposalBatch(decoratedBatch),
        items: items.map(serializeAssetDisposalItem),
        summary,
    };
};

export const getAllDisposalBatches = async (req: Request, res: Response, _next: NextFunction) => {
    const filter = buildBatchFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [batches, total] = await Promise.all([
        applyPopulate(AssetDisposalBatch.find(filter), BATCH_POPULATE).sort('-createdAt').skip(skip).limit(limit),
        AssetDisposalBatch.countDocuments(filter),
    ]);
    const decorated = await decorateBatchCounts(batches);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(decorated.map(serializeAssetDisposalBatch), total, page, limit),
            message: 'Lay danh sach dot thanh ly thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createDisposalBatch = async (req: Request, res: Response, _next: NextFunction) => {
    const batch = await AssetDisposalBatch.create({
        ...req.body,
        code: await createUniqueBatchCode(),
        status: ASSET_DISPOSAL_BATCH_STATUS.SCANNING,
        createdBy: req.userId,
        updatedBy: req.userId,
    });
    const populated = await getBatchOrThrow(String(batch._id));
    const [decorated] = await decorateBatchCounts([populated]);

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeAssetDisposalBatch(decorated),
            message: 'Tao dot thanh ly thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const getDisposalBatchById = async (req: Request, res: Response, _next: NextFunction) => {
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: await buildDetail(getParamValue(req.params.id)),
            message: 'Lay chi tiet dot thanh ly thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const updateDisposalBatch = async (req: Request, res: Response, _next: NextFunction) => {
    const batch = await getBatchOrThrow(getParamValue(req.params.id));
    assertBatchEditable(batch);

    const updated = await applyPopulate(
        AssetDisposalBatch.findOneAndUpdate(
            { _id: batch._id, isDeleted: { $ne: true } },
            { ...req.body, updatedBy: req.userId },
            { returnDocument: 'after', runValidators: true }
        ),
        BATCH_POPULATE
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeAssetDisposalBatch((await decorateBatchCounts([updated]))[0]),
            message: 'Cap nhat dot thanh ly thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const addDisposalItem = async (req: Request, res: Response, _next: NextFunction) => {
    const batch = await getBatchOrThrow(getParamValue(req.params.id));
    assertBatchEditable(batch);

    if (req.body.assetId) {
        const asset = await Asset.findOne({ _id: req.body.assetId, isDeleted: { $ne: true } })
            .populate('brandId')
            .populate('plantId');
        if (!asset) throw new NotFoundError('Khong tim thay may');

        const { item, duplicate } = await addAssetToBatch(asset, batch, req, req.body);
        return res.status(duplicate ? StatusCodes.OK : StatusCodes.CREATED).json(
            customResponse({
                data: serializeAssetDisposalItem(item),
                message: duplicate ? 'May da nam trong dot thanh ly' : 'Da them may vao dot thanh ly',
                status: duplicate ? StatusCodes.OK : StatusCodes.CREATED,
                success: true,
            })
        );
    }

    const publicId = req.body.publicId ? normalizePublicId(req.body.publicId) : undefined;
    const matchedAsset = await findAssetByManualIdentity({ ...req.body, publicId });
    if (matchedAsset) {
        const { item, duplicate } = await addAssetToBatch(matchedAsset, batch, req, { ...req.body, publicId });
        return res.status(duplicate ? StatusCodes.OK : StatusCodes.CREATED).json(
            customResponse({
                data: serializeAssetDisposalItem(item),
                message: duplicate
                    ? 'May da nam trong dot thanh ly'
                    : 'Ma nhap khop may trong he thong, da them theo ho so may',
                status: duplicate ? StatusCodes.OK : StatusCodes.CREATED,
                success: true,
            })
        );
    }
    if (publicId) {
        const existingQrItem = await AssetDisposalItem.findOne({
            batchId: batch._id,
            publicId,
            isDeleted: { $ne: true },
            status: { $nin: FINAL_ITEM_STATUSES },
        });
        if (existingQrItem) {
            return res.status(StatusCodes.OK).json(
                customResponse({
                    data: serializeAssetDisposalItem(await populateItem(existingQrItem._id)),
                    message: 'QR nay da nam trong dot thanh ly',
                    status: StatusCodes.OK,
                    success: true,
                })
            );
        }
    }
    await assertPublicIdAvailableForBatch(publicId, String(batch._id));

    const sourceType =
        req.body.sourceType ?? (publicId ? ASSET_DISPOSAL_SOURCE_TYPE.QR_ONLY : ASSET_DISPOSAL_SOURCE_TYPE.EXTERNAL);
    const item = await AssetDisposalItem.create({
        ...req.body,
        batchId: batch._id,
        sourceType,
        publicId,
        plantId: getBatchPlantId(batch),
        area: trim(req.body.area) ?? batch.area,
        status: req.body.status ?? ASSET_DISPOSAL_ITEM_STATUS.PENDING,
        createdBy: req.userId,
        updatedBy: req.userId,
    });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeAssetDisposalItem(await populateItem(item._id)),
            message: 'Da them dong may thanh ly ngoai he thong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const scanDisposalQr = async (req: Request, res: Response, _next: NextFunction) => {
    const batch = await getBatchOrThrow(getParamValue(req.params.id));
    assertBatchEditable(batch);

    const publicId = extractPublicId(req.body.rawValue);
    const label = await QrLabel.findOne({ publicId, isDeleted: { $ne: true } }).populate({
        path: 'assetId',
        populate: ['brandId', 'plantId'],
    });

    // Tem da bi thay the/thu hoi van con assetId cu -> tuyet doi khong resolve ve may,
    // neu khong 2 tem khac nhau se bi tinh la cung 1 may (bug quet trung may)
    if (label && label.status !== QR_LABEL_STATUS.ASSIGNED && label.status !== QR_LABEL_STATUS.UNUSED) {
        throw new BadRequestError(
            `Tem QR ${publicId} da bi thay the/thu hoi${
                (label as any).retiredReason ? ` (${(label as any).retiredReason})` : ''
            }. Kiem tra lai tem dang dan tren may`
        );
    }

    if (label?.status === QR_LABEL_STATUS.ASSIGNED && label.assetId && typeof label.assetId === 'object') {
        const { item, duplicate } = await addAssetToBatch(label.assetId, batch, req, {
            ...req.body,
            publicId,
            qrLabelId: label._id,
        });
        if (!(item as any).qrLabelId) {
            await AssetDisposalItem.updateOne({ _id: (item as any)._id }, { qrLabelId: label._id, publicId });
        }
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    item: serializeAssetDisposalItem(await populateItem((item as any)._id)),
                    result: duplicate ? 'duplicate' : 'asset',
                    canEditExternalInfo: false,
                },
                message: duplicate ? 'May da co trong dot thanh ly' : 'Da quet may vao dot thanh ly',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    if (label && label.status !== QR_LABEL_STATUS.UNUSED) {
        throw new BadRequestError('Tem QR nay khong kha dung cho dot thanh ly');
    }

    const asset = await findAssetByScanCandidate(publicId);
    if (asset) {
        const { item, duplicate } = await addAssetToBatch(asset, batch, req, {
            ...req.body,
            publicId,
            qrLabelId: label?._id,
        });
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    item: serializeAssetDisposalItem(item),
                    result: duplicate ? 'duplicate' : 'asset',
                    canEditExternalInfo: false,
                },
                message: duplicate ? 'May da co trong dot thanh ly' : 'Da quet may vao dot thanh ly',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const existingQrItem = await AssetDisposalItem.findOne({
        batchId: batch._id,
        publicId,
        isDeleted: { $ne: true },
    });
    if (existingQrItem) {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    item: serializeAssetDisposalItem(await populateItem(existingQrItem._id)),
                    result: 'duplicate',
                    canEditExternalInfo: true,
                },
                message: 'QR nay da nam trong dot thanh ly',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }
    await assertPublicIdAvailableForBatch(publicId, String(batch._id));

    const item = await AssetDisposalItem.create({
        batchId: batch._id,
        sourceType: ASSET_DISPOSAL_SOURCE_TYPE.QR_ONLY,
        qrLabelId: label?._id,
        publicId,
        plantId: batch.plantId?._id ?? batch.plantId,
        area: batch.area,
        condition: req.body.condition,
        reason: trim(req.body.reason) ?? trim(batch.reason),
        suggestedAction: req.body.suggestedAction,
        note: trim(req.body.note),
        status: ASSET_DISPOSAL_ITEM_STATUS.PENDING,
        checkedBy: req.userId,
        checkedAt: new Date(),
        createdBy: req.userId,
        updatedBy: req.userId,
    });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: {
                item: serializeAssetDisposalItem(await populateItem(item._id)),
                result: 'qr_only',
                canEditExternalInfo: true,
            },
            message: 'Da tao dong may thanh ly tam tu QR',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updateDisposalItem = async (req: Request, res: Response, _next: NextFunction) => {
    const current = await populateItem(getParamValue(req.params.itemId));
    if (!current) throw new NotFoundError('Khong tim thay dong thanh ly');

    const batch = await getBatchOrThrow(toId((current as any).batchId));
    assertBatchEditable(batch);

    const payload = { ...req.body, updatedBy: req.userId };
    if (payload.publicId) payload.publicId = normalizePublicId(payload.publicId);
    if (!(current as any).assetId) {
        const matchedAsset = await findAssetByManualIdentity(payload);
        if (matchedAsset) {
            throw new BadRequestError(
                `Ma nhap khop may trong he thong ${matchedAsset.machineCode || matchedAsset.name}. Hay them bang chuc nang chon/quet may trong he thong de tranh tao dong ngoai he thong sai.`
            );
        }
        await assertPublicIdAvailableForBatch(payload.publicId, String(batch._id), String((current as any)._id));
        payload.plantId = getBatchPlantId(batch);
        payload.area = trim(payload.area) ?? batch.area;
    }
    if (payload.status === ASSET_DISPOSAL_ITEM_STATUS.CHECKED && !(current as any).checkedAt) {
        payload.checkedBy = req.userId;
        payload.checkedAt = new Date();
    }

    const updated = await applyPopulate(
        AssetDisposalItem.findOneAndUpdate({ _id: current._id, isDeleted: { $ne: true } }, payload, {
            returnDocument: 'after',
            runValidators: true,
        }),
        ITEM_POPULATE
    );
    if (!updated) throw new NotFoundError('Khong tim thay dong thanh ly');

    if ([ASSET_DISPOSAL_ITEM_STATUS.KEPT, ASSET_DISPOSAL_ITEM_STATUS.CANCELLED].includes(updated.status)) {
        await revertAssetIfNeeded(updated, req);
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeAssetDisposalItem(updated),
            message: 'Cap nhat dong thanh ly thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const deleteDisposalItem = async (req: Request, res: Response, _next: NextFunction) => {
    const current = await populateItem(getParamValue(req.params.itemId));
    if (!current) throw new NotFoundError('Khong tim thay dong thanh ly');

    const batch = await getBatchOrThrow(toId((current as any).batchId));
    assertBatchEditable(batch);

    if (FINAL_ITEM_STATUSES.includes((current as any).status)) {
        throw new BadRequestError('Dong thanh ly da ket thuc, khong the xoa');
    }

    await revertAssetIfNeeded(current, req);

    await AssetDisposalItem.updateOne(
        { _id: (current as any)._id, isDeleted: { $ne: true } },
        {
            status: ASSET_DISPOSAL_ITEM_STATUS.CANCELLED,
            isDeleted: true,
            deletedAt: new Date(),
            updatedBy: req.userId,
        }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: await buildDetail(toId((current as any).batchId)),
            message: 'Da xoa dong thanh ly khoi dot',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const submitDisposalBatch = async (req: Request, res: Response, _next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const batch = await getBatchOrThrow(batchId);
    if (![ASSET_DISPOSAL_BATCH_STATUS.DRAFT, ASSET_DISPOSAL_BATCH_STATUS.SCANNING].includes(batch.status)) {
        throw new BadRequestError('Chi dot dang ra soat moi duoc gui duyet');
    }

    await validateBatchItemsBeforeWorkflow(batch);

    await AssetDisposalBatch.updateOne(
        { _id: batchId },
        {
            status: ASSET_DISPOSAL_BATCH_STATUS.REVIEWING,
            submittedBy: req.userId,
            submittedAt: new Date(),
            note: trim(req.body.note) ?? batch.note,
            updatedBy: req.userId,
        }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: await buildDetail(batchId),
            message: 'Da gui dot thanh ly cho duyet',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const approveDisposalBatch = async (req: Request, res: Response, _next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const batch = await getBatchOrThrow(batchId);
    if (batch.status !== ASSET_DISPOSAL_BATCH_STATUS.REVIEWING) {
        throw new BadRequestError('Chi dot dang cho duyet moi duoc phe duyet');
    }
    await validateBatchItemsBeforeWorkflow(batch);

    await AssetDisposalBatch.updateOne(
        { _id: batchId },
        {
            status: ASSET_DISPOSAL_BATCH_STATUS.APPROVED,
            approvedBy: req.userId,
            approvedAt: new Date(),
            approvalNote: trim(req.body.note),
            updatedBy: req.userId,
        }
    );
    await AssetDisposalItem.updateMany(
        {
            batchId,
            isDeleted: { $ne: true },
            status: { $in: [ASSET_DISPOSAL_ITEM_STATUS.PENDING, ASSET_DISPOSAL_ITEM_STATUS.CHECKED] },
        },
        { status: ASSET_DISPOSAL_ITEM_STATUS.APPROVED, updatedBy: req.userId }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: await buildDetail(batchId),
            message: 'Da duyet dot thanh ly',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const completeDisposalBatch = async (req: Request, res: Response, _next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const batch = await getBatchOrThrow(batchId);
    if (batch.status !== ASSET_DISPOSAL_BATCH_STATUS.APPROVED) {
        throw new BadRequestError('Chi dot da duoc duyet moi duoc hoan tat thanh ly');
    }

    const items = await applyPopulate(
        AssetDisposalItem.find({
            batchId,
            isDeleted: { $ne: true },
            status: { $nin: [ASSET_DISPOSAL_ITEM_STATUS.KEPT, ASSET_DISPOSAL_ITEM_STATUS.CANCELLED] },
        }),
        ITEM_POPULATE
    );

    for (const item of items) {
        const assetId = toId((item as any).assetId);
        if (assetId) {
            const updatedAsset = await Asset.findOneAndUpdate(
                { _id: assetId, isDeleted: { $ne: true } },
                {
                    status: ASSET_STATUS.DISPOSED,
                    statusNote: `Thanh ly theo dot ${batch.code}`,
                    updatedBy: req.userId,
                },
                { returnDocument: 'after' }
            )
                .populate('brandId')
                .populate('plantId');
            broadcastAssetChange(updatedAsset, 'disposal-completed', ['status', 'statusNote']);
        }

        await retireQrForItem(item, req, `Disposed in batch ${batch.code}`);
        await AssetDisposalItem.updateOne(
            { _id: item._id },
            {
                status: ASSET_DISPOSAL_ITEM_STATUS.DISPOSED,
                disposedAt: new Date(),
                updatedBy: req.userId,
            }
        );
    }

    await AssetDisposalBatch.updateOne(
        { _id: batchId },
        {
            status: ASSET_DISPOSAL_BATCH_STATUS.COMPLETED,
            completedBy: req.userId,
            completedAt: new Date(),
            updatedBy: req.userId,
        }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: await buildDetail(batchId),
            message: 'Da hoan tat dot thanh ly',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const cancelDisposalBatch = async (req: Request, res: Response, _next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const batch = await getBatchOrThrow(batchId);
    if (FINAL_BATCH_STATUSES.includes(batch.status)) {
        throw new BadRequestError('Dot thanh ly da ket thuc');
    }

    const items = await AssetDisposalItem.find({
        batchId,
        isDeleted: { $ne: true },
        status: { $nin: FINAL_ITEM_STATUSES },
    });
    for (const item of items) {
        await revertAssetIfNeeded(item, req);
    }

    await AssetDisposalItem.updateMany(
        { batchId, isDeleted: { $ne: true }, status: { $nin: [ASSET_DISPOSAL_ITEM_STATUS.DISPOSED] } },
        { status: ASSET_DISPOSAL_ITEM_STATUS.CANCELLED, updatedBy: req.userId }
    );
    await AssetDisposalBatch.updateOne(
        { _id: batchId },
        {
            status: ASSET_DISPOSAL_BATCH_STATUS.CANCELLED,
            cancelledBy: req.userId,
            cancelledAt: new Date(),
            cancelReason: req.body.reason,
            updatedBy: req.userId,
        }
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: await buildDetail(batchId),
            message: 'Da huy dot thanh ly',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportDisposalBatchXlsx = async (req: Request, res: Response, _next: NextFunction) => {
    const detail = await buildDetail(getParamValue(req.params.id));
    const buffer = await generateAssetDisposalXlsx(detail);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="thanh-ly-may-${detail.batch.code}.xlsx"`);
    return res.status(StatusCodes.OK).send(buffer);
};

export const disposalBlockedStatuses = ASSET_DISPOSAL_BLOCKED_STATUSES;
