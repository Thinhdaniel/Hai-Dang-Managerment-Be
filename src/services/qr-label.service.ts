import { customAlphabet } from 'nanoid';
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import { NextFunction, Request, Response } from 'express';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { QR_LABEL_BATCH_STATUS, QR_LABEL_STATUS, QR_LABEL_TYPE } from '@/constant/qrLabel';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import { emitToAll } from '@/lib/socket';
import Asset from '@/models/Asset';
import Brand from '@/models/Brand';
import QrLabel from '@/models/QrLabel';
import QrLabelBatch from '@/models/QrLabelBatch';
import { ensureTypeCode, generateMachineCode } from '@/services/machine-code.service';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { serializeAsset, serializePlant, serializePublicAsset } from '@/utils/serializers';

const QR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QR_PUBLIC_ID_LENGTH = 8;
const generateQrToken = customAlphabet(QR_ALPHABET, QR_PUBLIC_ID_LENGTH);
const ASSET_SOCKET_EVENTS = {
    CREATED: 'asset:created',
    UPDATED: 'asset:updated',
} as const;

const toPlain = (value: any) => (typeof value?.toObject === 'function' ? value.toObject() : value);
const toId = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};
const toIso = (value: any) => (value ? new Date(value).toISOString() : undefined);
const normalizePublicId = (value: string) => value.trim().toUpperCase();
const routeParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] || '' : value || '');
const createQrPublicId = () => `QR-${generateQrToken()}`;

const getUserId = (req: Request) =>
    req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : undefined;

const getPopulatedPlant = (value: any) =>
    value && typeof value === 'object' && value.name ? serializePlant(value) : undefined;

const broadcastAssetChange = (
    event: (typeof ASSET_SOCKET_EVENTS)[keyof typeof ASSET_SOCKET_EVENTS],
    asset: unknown,
    action: string,
    changedFields: string[] = []
) => {
    if (!asset) return;

    const serializedAsset = serializeAsset(asset);

    emitToAll(event, {
        action,
        assetId: serializedAsset.id,
        asset: serializedAsset,
        changedFields,
        updatedAt: serializedAsset.updatedAt ?? new Date().toISOString(),
    });
};

const serializeBatch = (input: any, extra?: { assignedCount?: number; unusedCount?: number }) => {
    const batch = toPlain(input);
    const plant = getPopulatedPlant(batch?.plantId);

    return {
        id: toId(batch),
        code: batch?.code,
        type: batch?.type ?? QR_LABEL_TYPE.MACHINE,
        quantity: batch?.quantity ?? 0,
        status: batch?.status ?? QR_LABEL_BATCH_STATUS.DRAFT,
        plantId: plant?.id ?? toId(batch?.plantId),
        plant,
        area: batch?.area,
        note: batch?.note,
        printedAt: toIso(batch?.printedAt),
        createdAt: toIso(batch?.createdAt),
        updatedAt: toIso(batch?.updatedAt),
        assignedCount: extra?.assignedCount,
        unusedCount: extra?.unusedCount,
    };
};

const serializeLabel = (input: any) => {
    const label = toPlain(input);
    const plannedPlant = getPopulatedPlant(label?.plannedPlantId);
    const batch = label?.batchId && typeof label.batchId === 'object' && label.batchId.code ? label.batchId : undefined;
    const asset =
        label?.assetId && typeof label.assetId === 'object' && label.assetId.name
            ? serializeAsset(label.assetId)
            : undefined;

    return {
        id: toId(label),
        publicId: label?.publicId,
        type: label?.type ?? QR_LABEL_TYPE.MACHINE,
        status: label?.status ?? QR_LABEL_STATUS.UNUSED,
        assetId: asset?.id ?? toId(label?.assetId),
        asset,
        batchId: batch?._id ? String(batch._id) : toId(label?.batchId),
        batchCode: batch?.code,
        plannedPlantId: plannedPlant?.id ?? toId(label?.plannedPlantId),
        plannedPlant,
        plannedArea: label?.plannedArea,
        note: label?.note,
        printedAt: toIso(label?.printedAt),
        activatedAt: toIso(label?.activatedAt),
        retiredAt: toIso(label?.retiredAt),
        retiredReason: label?.retiredReason,
        scanCount: label?.scanCount ?? 0,
        lastScannedAt: toIso(label?.lastScannedAt),
        createdAt: toIso(label?.createdAt),
        updatedAt: toIso(label?.updatedAt),
    };
};

const serializePublicLabel = (input: any) => {
    const label = toPlain(input);

    return {
        publicId: label?.publicId,
        type: label?.type ?? QR_LABEL_TYPE.MACHINE,
        status: label?.status ?? QR_LABEL_STATUS.UNUSED,
    };
};

const buildLabelFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.batchId) filter.batchId = query.batchId;
    if (query.plantId) filter.plannedPlantId = query.plantId;
    if (query.search) {
        const regex = new RegExp(
            String(query.search)
                .trim()
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            'i'
        );
        filter.$or = [{ publicId: regex }, { plannedArea: regex }, { note: regex }];
    }
    return filter;
};

const buildBatchFilter = (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.plantId) filter.plantId = query.plantId;
    if (query.search) {
        const regex = new RegExp(
            String(query.search)
                .trim()
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            'i'
        );
        filter.$or = [{ code: regex }, { area: regex }, { note: regex }];
    }
    return filter;
};

const assertMachineLabel = (label: any) => {
    if (!label || label.type !== QR_LABEL_TYPE.MACHINE) {
        throw new BadRequestError('Tem QR nay khong phai loai may');
    }
};

const assertLabelCanAssign: (label: any) => asserts label = (label: any) => {
    if (!label) throw new NotFoundError('Khong tim thay tem QR');
    assertMachineLabel(label);
    if (label.status !== QR_LABEL_STATUS.UNUSED || label.assetId) {
        throw new BadRequestError('Tem QR nay da duoc kich hoat hoac khong con kha dung');
    }
};

const assertValidAssetOwnershipStatus = (status?: string, ownershipType?: string) => {
    const normalizedOwnershipType = ownershipType || ASSET_OWNERSHIP_TYPE.OWNED;
    if (status === ASSET_STATUS.RETURNED_TO_PARTNER && normalizedOwnershipType === ASSET_OWNERSHIP_TYPE.OWNED) {
        throw new BadRequestError('May da tra doi tac phai la may muon doi tac hoac may thue');
    }
};

const ensureMachineCodeAvailable = async (machineCode: string, session?: mongoose.ClientSession) => {
    const existing = await Asset.findOne({
        machineCode,
        isDeleted: { $ne: true },
    })
        .select('_id machineCode')
        .session(session ?? null)
        .lean();

    if (existing) {
        throw new DuplicateError('Ma may da ton tai');
    }
};

const ensurePublicIdAvailable = async (publicId: string, session?: mongoose.ClientSession) => {
    const [existingLabel, existingAsset] = await Promise.all([
        QrLabel.exists({ publicId }).session(session ?? null),
        Asset.exists({ publicId }).session(session ?? null),
    ]);

    if (existingLabel || existingAsset) {
        throw new DuplicateError('Ma QR da ton tai');
    }
};

const generateUniquePublicIds = async (quantity: number): Promise<string[]> => {
    const publicIds = new Set<string>();

    while (publicIds.size < quantity) {
        publicIds.add(createQrPublicId());
    }

    const ids = [...publicIds];
    const [existingLabels, existingAssets] = await Promise.all([
        QrLabel.find({ publicId: { $in: ids } })
            .select('publicId')
            .lean(),
        Asset.find({ publicId: { $in: ids } })
            .select('publicId')
            .lean(),
    ]);

    const conflicts = new Set([
        ...existingLabels.map((row: any) => row.publicId),
        ...existingAssets.map((row: any) => row.publicId),
    ]);

    if (!conflicts.size) return ids;

    const cleanIds = ids.filter((id) => !conflicts.has(id));
    const missingCount = quantity - cleanIds.length;
    return [...cleanIds, ...(await generateUniquePublicIds(missingCount))];
};

const createUniqueBatchCode = async (): Promise<string> => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    for (let attempt = 0; attempt < 12; attempt += 1) {
        const code = `QR-${stamp}-${generateQrToken().slice(0, 4)}`;
        const exists = await QrLabelBatch.exists({ code });
        if (!exists) return code;
    }

    throw new Error('Unable to generate a unique QR batch code');
};

const refreshBatchStatus = async (batchId?: string, session?: mongoose.ClientSession) => {
    if (!batchId) return;

    const [batch, assignedCount, unusedCount] = await Promise.all([
        QrLabelBatch.findById(batchId).session(session ?? null),
        QrLabel.countDocuments({
            batchId,
            isDeleted: { $ne: true },
            status: QR_LABEL_STATUS.ASSIGNED,
        }).session(session ?? null),
        QrLabel.countDocuments({
            batchId,
            isDeleted: { $ne: true },
            status: QR_LABEL_STATUS.UNUSED,
        }).session(session ?? null),
    ]);

    if (!batch) return;

    if (assignedCount >= Number(batch.quantity ?? 0) && Number(batch.quantity ?? 0) > 0) {
        batch.status = QR_LABEL_BATCH_STATUS.COMPLETED;
    } else if (assignedCount > 0) {
        batch.status = QR_LABEL_BATCH_STATUS.PARTIALLY_ASSIGNED;
    } else if (batch.printedAt) {
        batch.status = QR_LABEL_BATCH_STATUS.PRINTED;
    } else if (unusedCount > 0) {
        batch.status = QR_LABEL_BATCH_STATUS.DRAFT;
    }

    await batch.save({ session });
};

const findLabelByPublicId = (publicId: string) =>
    QrLabel.findOne({ publicId: normalizePublicId(publicId), isDeleted: { $ne: true } })
        .populate('plannedPlantId')
        .populate('batchId')
        .populate({
            path: 'assetId',
            populate: [{ path: 'brandId' }, { path: 'plantId' }],
        });

const getLegacyAssetByPublicId = (publicId: string) =>
    Asset.findOne({ publicId: normalizePublicId(publicId), isDeleted: { $ne: true } })
        .populate('brandId')
        .populate('plantId');

export const createLabel = async (req: Request, res: Response, next: NextFunction) => {
    const publicId = createQrPublicId();
    await ensurePublicIdAvailable(publicId);

    const label = await QrLabel.create({
        publicId,
        type: req.body.type ?? QR_LABEL_TYPE.MACHINE,
        plannedPlantId: req.body.plannedPlantId,
        plannedArea: req.body.plannedArea,
        note: req.body.note,
        createdBy: getUserId(req),
        updatedBy: getUserId(req),
    });

    const createdLabel = await QrLabel.findById(label._id).populate('plannedPlantId');

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeLabel(createdLabel),
            message: 'Tao tem QR thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const createBatch = async (req: Request, res: Response, next: NextFunction) => {
    const userId = getUserId(req);
    const quantity = Number(req.body.quantity);
    const batchCode = await createUniqueBatchCode();
    const publicIds = await generateUniquePublicIds(quantity);

    const batch = await QrLabelBatch.create({
        code: batchCode,
        type: req.body.type ?? QR_LABEL_TYPE.MACHINE,
        quantity,
        plantId: req.body.plantId,
        area: req.body.area,
        note: req.body.note,
        createdBy: userId,
        updatedBy: userId,
    });

    // Sinh mã đã đảm bảo unique toàn hệ thống (check cả QrLabel + Asset). Unique index trên
    // publicId là chốt chặn cuối: nếu 2 lô tạo đồng thời lỡ trùng, index từ chối bản trùng.
    // Ta nuốt lỗi trùng rồi BÙ thêm mã mới cho đủ số lượng, thay vì để lô thiếu tem hoặc hỏng cả request.
    const isDuplicateKeyError = (error: any) =>
        error?.code === 11000 || Array.isArray(error?.writeErrors) || error?.name === 'MongoBulkWriteError';

    let pendingIds = publicIds;
    for (let attempt = 0; attempt < 5 && pendingIds.length; attempt += 1) {
        try {
            await QrLabel.insertMany(
                pendingIds.map((publicId) => ({
                    publicId,
                    type: req.body.type ?? QR_LABEL_TYPE.MACHINE,
                    batchId: batch._id,
                    plannedPlantId: req.body.plantId,
                    plannedArea: req.body.area,
                    note: req.body.note,
                    createdBy: userId,
                    updatedBy: userId,
                })),
                { ordered: false }
            );
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
        const inserted = await QrLabel.countDocuments({ batchId: batch._id, isDeleted: { $ne: true } });
        if (inserted >= quantity) break;
        pendingIds = await generateUniquePublicIds(quantity - inserted);
    }

    const createdBatch = await QrLabelBatch.findById(batch._id).populate('plantId');

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeBatch(createdBatch, { assignedCount: 0, unusedCount: quantity }),
            message: 'Tao lo tem QR thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const getLabels = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildLabelFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [labels, total] = await Promise.all([
        QrLabel.find(filter)
            .sort(String(req.query.sort || '-createdAt'))
            .skip(skip)
            .limit(limit)
            .populate('plannedPlantId')
            .populate('batchId')
            .populate({
                path: 'assetId',
                populate: [{ path: 'brandId' }, { path: 'plantId' }],
            }),
        QrLabel.countDocuments(filter),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(labels.map(serializeLabel), total, page, limit),
            message: 'Lay danh sach tem QR thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getBatches = async (req: Request, res: Response, next: NextFunction) => {
    const filter = buildBatchFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [batches, total] = await Promise.all([
        QrLabelBatch.find(filter)
            .sort(String(req.query.sort || '-createdAt'))
            .skip(skip)
            .limit(limit)
            .populate('plantId'),
        QrLabelBatch.countDocuments(filter),
    ]);

    const batchIds = batches.map((batch) => batch._id);
    const counts = batchIds.length
        ? await QrLabel.aggregate<{ _id: string; assignedCount: number; unusedCount: number }>([
              { $match: { batchId: { $in: batchIds }, isDeleted: { $ne: true } } },
              {
                  $group: {
                      _id: '$batchId',
                      assignedCount: {
                          $sum: { $cond: [{ $eq: ['$status', QR_LABEL_STATUS.ASSIGNED] }, 1, 0] },
                      },
                      unusedCount: {
                          $sum: { $cond: [{ $eq: ['$status', QR_LABEL_STATUS.UNUSED] }, 1, 0] },
                      },
                  },
              },
          ])
        : [];
    const countMap = new Map(counts.map((row) => [String(row._id), row]));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(
                batches.map((batch) => {
                    const row = countMap.get(String(batch._id));
                    return serializeBatch(batch, {
                        assignedCount: row?.assignedCount ?? 0,
                        unusedCount: row?.unusedCount ?? 0,
                    });
                }),
                total,
                page,
                limit
            ),
            message: 'Lay danh sach lo tem QR thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getBatchById = async (req: Request, res: Response, next: NextFunction) => {
    const [batch, labels] = await Promise.all([
        QrLabelBatch.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).populate('plantId'),
        QrLabel.find({ batchId: req.params.id, isDeleted: { $ne: true } })
            .sort('createdAt')
            .populate('plannedPlantId')
            .populate({
                path: 'assetId',
                populate: [{ path: 'brandId' }, { path: 'plantId' }],
            }),
    ]);

    if (!batch) throw new NotFoundError('Khong tim thay lo tem QR');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                batch: serializeBatch(batch, {
                    assignedCount: labels.filter((label) => label.status === QR_LABEL_STATUS.ASSIGNED).length,
                    unusedCount: labels.filter((label) => label.status === QR_LABEL_STATUS.UNUSED).length,
                }),
                labels: labels.map(serializeLabel),
            },
            message: 'Lay thong tin lo tem QR thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const markBatchPrinted = async (req: Request, res: Response, next: NextFunction) => {
    const now = new Date();
    const userId = getUserId(req);
    const batch = await QrLabelBatch.findOneAndUpdate(
        { _id: req.params.id, isDeleted: { $ne: true } },
        {
            status: QR_LABEL_BATCH_STATUS.PRINTED,
            printedAt: now,
            printedBy: userId,
            updatedBy: userId,
        },
        { returnDocument: 'after' }
    ).populate('plantId');

    if (!batch) throw new NotFoundError('Khong tim thay lo tem QR');

    await QrLabel.updateMany(
        { batchId: batch._id, isDeleted: { $ne: true }, printedAt: { $exists: false } },
        { printedAt: now, printedBy: userId, updatedBy: userId }
    );
    await refreshBatchStatus(String(batch._id));

    const refreshedBatch = await QrLabelBatch.findById(batch._id).populate('plantId');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeBatch(refreshedBatch),
            message: 'Da danh dau lo tem QR da in',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const resolvePublicQr = async (req: Request, res: Response, next: NextFunction) => {
    const publicId = normalizePublicId(routeParam(req.params.publicId));
    const label = await findLabelByPublicId(publicId);

    if (label) {
        QrLabel.updateOne({ _id: label._id }, { $inc: { scanCount: 1 }, lastScannedAt: new Date() })
            .exec()
            .catch(() => undefined);

        const asset =
            label.status === QR_LABEL_STATUS.ASSIGNED && label.assetId
                ? serializePublicAsset(label.assetId)
                : undefined;

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    source: 'qr_label',
                    publicId,
                    type: label.type,
                    status: label.status,
                    label: serializePublicLabel(label),
                    asset,
                },
                message: 'Lay thong tin QR thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const legacyAsset = await getLegacyAssetByPublicId(publicId);
    if (!legacyAsset) throw new NotFoundError('Khong tim thay tem QR hoac thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                source: 'legacy_asset',
                publicId,
                type: QR_LABEL_TYPE.MACHINE,
                status: QR_LABEL_STATUS.ASSIGNED,
                asset: serializePublicAsset(legacyAsset),
            },
            message: 'Lay thong tin QR thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const resolveInternalQr = async (req: Request, res: Response, next: NextFunction) => {
    const publicId = normalizePublicId(routeParam(req.params.publicId));
    const label = await findLabelByPublicId(publicId);

    if (label) {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    source: 'qr_label',
                    publicId,
                    type: label.type,
                    status: label.status,
                    label: serializeLabel(label),
                    // Chi tra asset khi tem dang gan may; tem retired/lost van giu assetId cu
                    // nhung khong duoc resolve ve may (tranh 2 tem cung tro 1 may khi quet)
                    asset:
                        label.status === QR_LABEL_STATUS.ASSIGNED && label.assetId
                            ? serializeAsset(label.assetId)
                            : undefined,
                    canActivate:
                        label.type === QR_LABEL_TYPE.MACHINE &&
                        label.status === QR_LABEL_STATUS.UNUSED &&
                        !label.assetId,
                },
                message: 'Lay thong tin QR noi bo thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const legacyAsset = await getLegacyAssetByPublicId(publicId);
    if (!legacyAsset) throw new NotFoundError('Khong tim thay tem QR hoac thiet bi');

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                source: 'legacy_asset',
                publicId,
                type: QR_LABEL_TYPE.MACHINE,
                status: QR_LABEL_STATUS.ASSIGNED,
                asset: serializeAsset(legacyAsset),
                canActivate: false,
            },
            message: 'Lay thong tin QR noi bo thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const activateMachineLabel = async (req: Request, res: Response, next: NextFunction) => {
    const publicId = normalizePublicId(routeParam(req.params.publicId));
    const userId = getUserId(req);
    const assetPayload = {
        ...req.body.asset,
        status: req.body.asset.status ?? ASSET_STATUS.ACTIVE,
        ownershipType: req.body.asset.ownershipType ?? ASSET_OWNERSHIP_TYPE.OWNED,
    };

    assertValidAssetOwnershipStatus(assetPayload.status, assetPayload.ownershipType);

    // Mã máy để trống -> tự sinh mã thông minh (giống tạo máy thường) để bớt thao tác hiện trường.
    let machineCode = typeof assetPayload.machineCode === 'string' ? assetPayload.machineCode.trim() : '';
    if (!machineCode) {
        const brand = await Brand.findOne({ _id: assetPayload.brandId, isDeleted: { $ne: true } })
            .select('name')
            .lean();
        const generated = await generateMachineCode({
            type: assetPayload.type,
            brandName: (brand as any)?.name,
            ownershipType: assetPayload.ownershipType,
        });
        machineCode = generated.machineCode;
        await ensureTypeCode(assetPayload.type, generated.typeCode, false);
    }
    assetPayload.machineCode = machineCode;

    const session = await mongoose.startSession();
    let createdAssetId = '';

    try {
        await session.withTransaction(async () => {
            const label = await QrLabel.findOne({ publicId, isDeleted: { $ne: true } }).session(session);
            assertLabelCanAssign(label);
            await ensureMachineCodeAvailable(assetPayload.machineCode, session);

            const [asset] = await Asset.create(
                [
                    {
                        ...assetPayload,
                        publicId,
                        createdBy: userId,
                        updatedBy: userId,
                    },
                ],
                { session }
            );

            createdAssetId = String(asset._id);

            await QrLabel.updateOne(
                { _id: label._id, status: QR_LABEL_STATUS.UNUSED, isDeleted: { $ne: true } },
                {
                    status: QR_LABEL_STATUS.ASSIGNED,
                    assetId: asset._id,
                    activatedAt: new Date(),
                    activatedBy: userId,
                    updatedBy: userId,
                },
                { session }
            );

            await refreshBatchStatus(toId(label.batchId), session);
        });
    } finally {
        await session.endSession();
    }

    const [asset, label] = await Promise.all([
        Asset.findById(createdAssetId).populate('brandId').populate('plantId'),
        findLabelByPublicId(publicId),
    ]);
    broadcastAssetChange(ASSET_SOCKET_EVENTS.CREATED, asset, 'qr-label-activated', ['publicId', 'created']);

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: {
                label: serializeLabel(label),
                asset: serializeAsset(asset),
            },
            message: 'Da kich hoat tem QR va tao may thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const linkAssetLabel = async (req: Request, res: Response, next: NextFunction) => {
    const publicId = normalizePublicId(routeParam(req.params.publicId));
    const userId = getUserId(req);
    const session = await mongoose.startSession();
    let linkedAssetId = '';

    try {
        await session.withTransaction(async () => {
            const [label, asset] = await Promise.all([
                QrLabel.findOne({ publicId, isDeleted: { $ne: true } }).session(session),
                Asset.findOne({ _id: req.body.assetId, isDeleted: { $ne: true } }).session(session),
            ]);

            assertLabelCanAssign(label);
            if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

            const existingPublicId = String(asset.publicId || '');
            if (existingPublicId && existingPublicId !== publicId && !req.body.replaceExistingPublicId) {
                throw new BadRequestError('May da co QR publicId. Can xac nhan thay the tem cu');
            }

            if (existingPublicId && existingPublicId !== publicId) {
                await QrLabel.updateMany(
                    {
                        assetId: asset._id,
                        publicId: { $ne: publicId },
                        status: QR_LABEL_STATUS.ASSIGNED,
                        isDeleted: { $ne: true },
                    },
                    {
                        status: QR_LABEL_STATUS.RETIRED,
                        retiredAt: new Date(),
                        retiredBy: userId,
                        retiredReason: `Replaced by ${publicId}`,
                        updatedBy: userId,
                    },
                    { session }
                );
            }

            asset.publicId = publicId;
            asset.updatedBy = userId as any;
            await asset.save({ session });
            linkedAssetId = String(asset._id);

            await QrLabel.updateOne(
                { _id: label._id, status: QR_LABEL_STATUS.UNUSED, isDeleted: { $ne: true } },
                {
                    status: QR_LABEL_STATUS.ASSIGNED,
                    assetId: asset._id,
                    activatedAt: new Date(),
                    activatedBy: userId,
                    updatedBy: userId,
                },
                { session }
            );

            await refreshBatchStatus(toId(label.batchId), session);
        });
    } finally {
        await session.endSession();
    }

    const [asset, label] = await Promise.all([
        Asset.findById(linkedAssetId).populate('brandId').populate('plantId'),
        findLabelByPublicId(publicId),
    ]);
    broadcastAssetChange(ASSET_SOCKET_EVENTS.UPDATED, asset, 'qr-label-linked', ['publicId']);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                label: serializeLabel(label),
                asset: serializeAsset(asset),
            },
            message: 'Da gan tem QR vao may',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const retireLabel = async (req: Request, res: Response, next: NextFunction) => {
    const userId = getUserId(req);
    const session = await mongoose.startSession();
    let labelId = '';

    try {
        await session.withTransaction(async () => {
            const label = await QrLabel.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).session(session);
            if (!label) throw new NotFoundError('Khong tim thay tem QR');

            labelId = String(label._id);
            label.status = req.body.status;
            label.retiredAt = new Date();
            label.retiredBy = userId as any;
            label.retiredReason = req.body.reason;
            label.updatedBy = userId as any;
            await label.save({ session });

            if (req.body.clearAssetPublicId && label.assetId) {
                await Asset.updateOne(
                    { _id: label.assetId, publicId: label.publicId },
                    { $unset: { publicId: '' }, updatedBy: userId },
                    { session }
                );
            }

            await refreshBatchStatus(toId(label.batchId), session);
        });
    } finally {
        await session.endSession();
    }

    const label = await QrLabel.findById(labelId)
        .populate('plannedPlantId')
        .populate('batchId')
        .populate({
            path: 'assetId',
            populate: [{ path: 'brandId' }, { path: 'plantId' }],
        });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeLabel(label),
            message: 'Da cap nhat trang thai tem QR',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
