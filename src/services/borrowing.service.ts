import { customAlphabet } from 'nanoid';
import mongoose from 'mongoose';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { QR_LABEL_BATCH_STATUS, QR_LABEL_STATUS, QR_LABEL_TYPE } from '@/constant/qrLabel';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import Borrowing from '@/models/Borrowing';
import BorrowingBatch from '@/models/BorrowingBatch';
import QrLabel from '@/models/QrLabel';
import QrLabelBatch from '@/models/QrLabelBatch';
import Transfer from '@/models/Transfer';
import { borrowingRepository } from '@/repositories/borrowing.repository';
import { getPagination } from '@/utils/pagination';
import { serializeBorrowing, serializeBorrowingBatch } from '@/utils/serializers';
import {
    applyPopulate,
    sendSerializedItem,
    sendSerializedList,
    sendSerializedPage,
    sendSuccess,
    WORKFLOW_POPULATE,
} from './service.helpers';
import { notifyAdmins, getActorName } from './notification.helper';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const QR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateQrToken = customAlphabet(QR_ALPHABET, 8);

const getParamValue = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

const trimText = (value?: string | null) => value?.trim() || undefined;

const isExternalOrRental = (type?: string) => type === 'external' || type === 'rental';

const getOwnershipTypeForBorrowing = (type: string) => {
    if (type === 'external') return ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED;
    if (type === 'rental') return ASSET_OWNERSHIP_TYPE.RENTAL;
    return ASSET_OWNERSHIP_TYPE.OWNED;
};

const toDocumentId = (value: unknown) =>
    !value
        ? undefined
        : value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)
          ? String((value as Record<string, unknown>)._id)
          : String(value);

const normalizePublicId = (value: string) => value.trim().toUpperCase();

const getUserId = (req: Request) =>
    req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : undefined;

const createDatedCode = (prefix: string) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

const createUniqueBorrowingBatchCode = async () => {
    const prefix = createDatedCode('BR');

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = `${prefix}-${generateQrToken().slice(0, 4)}`;
        const exists = await BorrowingBatch.exists({ code });
        if (!exists) return code;
    }

    throw new Error('Unable to generate borrowing batch code');
};

const createUniqueQrBatchCode = async () => {
    const prefix = createDatedCode('QRBR');

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = `${prefix}-${generateQrToken().slice(0, 4)}`;
        const exists = await QrLabelBatch.exists({ code });
        if (!exists) return code;
    }

    throw new Error('Unable to generate QR batch code');
};

const createQrPublicId = () => `QR-${generateQrToken()}`;

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
    return [...cleanIds, ...(await generateUniquePublicIds(quantity - cleanIds.length))];
};

const createUniquePartnerMachineCode = async (type: string, session?: mongoose.ClientSession) => {
    const prefix = type === 'rental' ? createDatedCode('RENT') : createDatedCode('EXT');

    for (let attempt = 0; attempt < 30; attempt += 1) {
        const code = `${prefix}-${generateQrToken().slice(0, 4)}`;
        const exists = await Asset.exists({ machineCode: code }).session(session ?? null);
        if (!exists) return code;
    }

    throw new Error('Unable to generate temporary machine code');
};

const ensureMachineCodeAvailable = async (machineCode: string, session?: mongoose.ClientSession) => {
    const exists = await Asset.exists({ machineCode, isDeleted: { $ne: true } }).session(session ?? null);
    if (exists) throw new DuplicateError('Ma may da ton tai');
};

const getQrRetiredStatus = (action: string) => {
    if (action === 'lost') return QR_LABEL_STATUS.LOST;
    if (action === 'damaged') return QR_LABEL_STATUS.DAMAGED;
    return QR_LABEL_STATUS.RETIRED;
};

const buildQrRetiredReason = (action: string, batchCode?: string, note?: string) => {
    const actionLabel: Record<string, string> = {
        removed: 'QR removed before partner return',
        lost: 'QR lost before partner return',
        damaged: 'QR damaged before partner return',
        left_on_partner: 'QR left on partner machine and deactivated',
    };

    return [batchCode, actionLabel[action] ?? action, note].filter(Boolean).join(' - ');
};

const buildFilter = async (query: Request['query']) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };

    if (query.assetId) filter.assetId = query.assetId;
    if (query.batchId) filter.batchId = query.batchId;
    if (query.borrowerId) filter.borrowerId = query.borrowerId;
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;

    if (query.startDate || query.endDate) {
        filter.borrowTime = {};
        if (query.startDate) filter.borrowTime.$gte = new Date(String(query.startDate));
        if (query.endDate) filter.borrowTime.$lte = new Date(String(query.endDate));
    }

    if (query.search) {
        const regex = new RegExp(String(query.search), 'i');
        const assetIds = await Asset.find({
            isDeleted: { $ne: true },
            $or: [{ name: regex }, { machineCode: regex }, { serial: regex }],
        }).distinct('_id');

        filter.$or = [
            { borrowerName: regex },
            { partnerName: regex },
            { purpose: regex },
            { location: regex },
            { note: regex },
            { assetId: { $in: assetIds } },
        ];
    }

    return filter;
};

const getBorrowingBatchCounts = async (batchIds: string[]) => {
    if (!batchIds.length) return new Map<string, Record<string, number>>();

    const rows = await Borrowing.aggregate<{
        _id: mongoose.Types.ObjectId;
        receivedCount: number;
        activeCount: number;
        returnedCount: number;
    }>([
        {
            $match: {
                batchId: { $in: batchIds.map((id) => new mongoose.Types.ObjectId(id)) },
                isDeleted: { $ne: true },
            },
        },
        {
            $group: {
                _id: '$batchId',
                receivedCount: { $sum: 1 },
                activeCount: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                returnedCount: { $sum: { $cond: [{ $eq: ['$status', 'returned'] }, 1, 0] } },
            },
        },
    ]);

    return new Map(rows.map((row) => [String(row._id), row]));
};

const getUnusedQrCounts = async (qrBatchIds: string[]) => {
    if (!qrBatchIds.length) return new Map<string, number>();

    const rows = await QrLabel.aggregate<{ _id: mongoose.Types.ObjectId; unusedQrCount: number }>([
        {
            $match: {
                batchId: { $in: qrBatchIds.map((id) => new mongoose.Types.ObjectId(id)) },
                isDeleted: { $ne: true },
                status: QR_LABEL_STATUS.UNUSED,
            },
        },
        { $group: { _id: '$batchId', unusedQrCount: { $sum: 1 } } },
    ]);

    return new Map(rows.map((row) => [String(row._id), row.unusedQrCount]));
};

const enrichBorrowingBatches = async (batches: any[]) => {
    const plainBatches = batches.map((batch) => (typeof batch?.toObject === 'function' ? batch.toObject() : batch));
    const batchIds = plainBatches.map((batch) => String(batch._id));
    const qrBatchIds = plainBatches
        .map((batch) => toDocumentId(batch.qrBatchId))
        .filter((id): id is string => Boolean(id));

    const [borrowingCounts, unusedQrCounts] = await Promise.all([
        getBorrowingBatchCounts(batchIds),
        getUnusedQrCounts(qrBatchIds),
    ]);

    return plainBatches.map((batch) => {
        const counts = borrowingCounts.get(String(batch._id));
        const qrBatchId = toDocumentId(batch.qrBatchId);

        return {
            ...batch,
            receivedCount: counts?.receivedCount ?? 0,
            activeCount: counts?.activeCount ?? 0,
            returnedCount: counts?.returnedCount ?? 0,
            unusedQrCount: qrBatchId ? (unusedQrCounts.get(qrBatchId) ?? 0) : undefined,
        };
    });
};

const refreshBorrowingBatchStatus = async (batchId: string, session?: mongoose.ClientSession) => {
    const batch = await BorrowingBatch.findById(batchId).session(session ?? null);
    if (!batch) return;

    const [receivedCount, activeCount, returnedCount] = await Promise.all([
        Borrowing.countDocuments({ batchId, isDeleted: { $ne: true } }).session(session ?? null),
        Borrowing.countDocuments({ batchId, status: 'active', isDeleted: { $ne: true } }).session(session ?? null),
        Borrowing.countDocuments({ batchId, status: 'returned', isDeleted: { $ne: true } }).session(session ?? null),
    ]);

    if (receivedCount === 0) {
        batch.status = batch.qrBatchId ? 'receiving' : 'draft';
        batch.closedAt = undefined;
        batch.closedBy = undefined;
    } else if (activeCount === 0 && returnedCount > 0) {
        batch.status = 'returned';
        batch.closedAt = batch.closedAt ?? new Date();
    } else if (returnedCount > 0) {
        batch.status = 'partially_returned';
        batch.closedAt = undefined;
        batch.closedBy = undefined;
    } else if (receivedCount >= Number(batch.plannedQuantity ?? 0)) {
        batch.status = 'active';
        batch.closedAt = undefined;
        batch.closedBy = undefined;
    } else {
        batch.status = 'receiving';
        batch.closedAt = undefined;
        batch.closedBy = undefined;
    }

    await batch.save({ session });
};

export const getAllBorrowings = async (req: Request, res: Response, next: NextFunction) => {
    const filter = await buildFilter(req.query);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    const [items, total] = await Promise.all([
        borrowingRepository.findMany(filter, { sort: '-borrowTime', skip, limit }),
        borrowingRepository.countDocuments(filter),
    ]);

    return sendSerializedPage(
        res,
        items,
        total,
        page,
        limit,
        serializeBorrowing,
        'Lay danh sach giao dich thiet bi thanh cong'
    );
};

export const getBorrowingByAsset = async (req: Request, res: Response, next: NextFunction) => {
    const assetId = getParamValue(req.params.assetId);
    const items = await borrowingRepository.findByAssetId(assetId);

    return sendSerializedList(res, items, serializeBorrowing, 'Lay lich su giao dich thiet bi thanh cong');
};

export const getBorrowingById = async (req: Request, res: Response, next: NextFunction) => {
    const borrowingId = getParamValue(req.params.id);
    const item = await borrowingRepository.findById(borrowingId);

    if (!item) throw new NotFoundError('Khong tim thay giao dich thiet bi');

    return sendSerializedItem(res, item, serializeBorrowing, 'Lay chi tiet giao dich thiet bi thanh cong');
};

export const getAllBorrowingBatches = async (req: Request, res: Response, next: NextFunction) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);

    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.plantId) filter.plantId = req.query.plantId;

    if (req.query.search) {
        const regex = new RegExp(
            String(req.query.search)
                .trim()
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            'i'
        );
        filter.$or = [{ code: regex }, { partnerName: regex }, { contractNo: regex }, { area: regex }, { note: regex }];
    }

    const [items, total] = await Promise.all([
        applyPopulate(BorrowingBatch.find(filter), WORKFLOW_POPULATE.borrowingBatch)
            .sort('-borrowTime -createdAt')
            .skip(skip)
            .limit(limit),
        BorrowingBatch.countDocuments(filter),
    ]);

    const enrichedItems = await enrichBorrowingBatches(items);

    return sendSerializedPage(
        res,
        enrichedItems,
        total,
        page,
        limit,
        serializeBorrowingBatch,
        'Lay danh sach lo muon / thue thanh cong'
    );
};

const createTemporaryQrBatchForBorrowingBatch = async (
    batch: any,
    quantity: number,
    userId?: string,
    session?: mongoose.ClientSession
) => {
    if (batch.qrBatchId) {
        throw new DuplicateError('Lo muon / thue nay da co lo tem QR');
    }

    const publicIds = await generateUniquePublicIds(quantity);
    const qrBatchCode = await createUniqueQrBatchCode();

    const [qrBatch] = await QrLabelBatch.create(
        [
            {
                code: qrBatchCode,
                type: QR_LABEL_TYPE.MACHINE,
                quantity,
                status: QR_LABEL_BATCH_STATUS.DRAFT,
                plantId: batch.plantId,
                area: batch.area,
                note: `Tem QR tam cho lo ${batch.code}`,
                createdBy: userId,
                updatedBy: userId,
            },
        ],
        { session }
    );

    await QrLabel.insertMany(
        publicIds.map((publicId) => ({
            publicId,
            type: QR_LABEL_TYPE.MACHINE,
            batchId: qrBatch._id,
            plannedPlantId: batch.plantId,
            plannedArea: batch.area,
            note: `Tem tam ${batch.code}`,
            createdBy: userId,
            updatedBy: userId,
        })),
        { session, ordered: false }
    );

    batch.qrBatchId = qrBatch._id;
    batch.status = 'receiving';
    batch.updatedBy = userId;
    await batch.save({ session });

    return qrBatch;
};

export const createBorrowingBatch = async (req: Request, res: Response, next: NextFunction) => {
    const userId = getUserId(req);
    const code = await createUniqueBorrowingBatchCode();
    const session = await mongoose.startSession();
    let createdBatchId = '';

    try {
        await session.withTransaction(async () => {
            const [batch] = await BorrowingBatch.create(
                [
                    {
                        code,
                        type: req.body.type,
                        partnerName: trimText(req.body.partnerName),
                        contractNo: trimText(req.body.contractNo),
                        plantId: req.body.plantId,
                        area: trimText(req.body.area),
                        borrowTime: req.body.borrowTime,
                        expectedReturnTime: req.body.expectedReturnTime,
                        plannedQuantity: req.body.plannedQuantity,
                        note: trimText(req.body.note),
                        createdBy: userId,
                        updatedBy: userId,
                    },
                ],
                { session }
            );

            createdBatchId = String(batch._id);

            if (req.body.createQrBatch) {
                await createTemporaryQrBatchForBorrowingBatch(batch, Number(req.body.plannedQuantity), userId, session);
            }
        });
    } finally {
        await session.endSession();
    }

    const [batch] = await enrichBorrowingBatches([
        await applyPopulate(BorrowingBatch.findById(createdBatchId), WORKFLOW_POPULATE.borrowingBatch),
    ]);

    return sendSerializedItem(
        res,
        batch,
        serializeBorrowingBatch,
        'Tao lo muon / thue thanh cong',
        StatusCodes.CREATED
    );
};

export const getBorrowingBatchById = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const batch = await applyPopulate(
        BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }),
        WORKFLOW_POPULATE.borrowingBatch
    );

    if (!batch) throw new NotFoundError('Khong tim thay lo muon / thue');

    const [enrichedBatch] = await enrichBorrowingBatches([batch]);
    const items = await borrowingRepository.findByBatchId(batchId);

    return sendSuccess(
        res,
        {
            batch: serializeBorrowingBatch(enrichedBatch),
            items: items.map(serializeBorrowing),
        },
        'Lay chi tiet lo muon / thue thanh cong'
    );
};

export const createBorrowingBatchQr = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const userId = getUserId(req);
    const session = await mongoose.startSession();

    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo muon / thue');

            await createTemporaryQrBatchForBorrowingBatch(
                batch,
                Number(req.body.quantity || batch.plannedQuantity),
                userId,
                session
            );
        });
    } finally {
        await session.endSession();
    }

    const [batch] = await enrichBorrowingBatches([
        await applyPopulate(BorrowingBatch.findById(batchId), WORKFLOW_POPULATE.borrowingBatch),
    ]);

    return sendSerializedItem(res, batch, serializeBorrowingBatch, 'Da tao lo QR tam cho lo muon / thue');
};

export const receiveBorrowingBatchByQr = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const userId = getUserId(req);
    const publicId = normalizePublicId(req.body.publicId);
    const session = await mongoose.startSession();
    let createdBorrowingId = '';

    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo muon / thue');
            if (!batch.qrBatchId) throw new BadRequestError('Lo nay chua co lo tem QR tam');
            if (batch.status === 'returned' || batch.status === 'cancelled') {
                throw new BadRequestError('Lo muon / thue nay da dong, khong the nhan them may');
            }

            const label = await QrLabel.findOne({ publicId, isDeleted: { $ne: true } }).session(session);
            if (!label) throw new NotFoundError('Khong tim thay tem QR');
            if (label.type !== QR_LABEL_TYPE.MACHINE) throw new BadRequestError('Tem QR nay khong phai tem may');
            if (String(label.batchId || '') !== String(batch.qrBatchId)) {
                throw new BadRequestError('Tem QR nay khong thuoc lo muon / thue dang thao tac');
            }
            if (label.status !== QR_LABEL_STATUS.UNUSED || label.assetId) {
                throw new BadRequestError('Tem QR nay da duoc kich hoat hoac khong con kha dung');
            }

            const assetPayload = req.body.asset;
            const machineCode =
                trimText(assetPayload.machineCode) || (await createUniquePartnerMachineCode(batch.type, session));
            await ensureMachineCodeAvailable(machineCode, session);

            const ownershipType =
                batch.type === 'rental' ? ASSET_OWNERSHIP_TYPE.RENTAL : ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED;

            const [asset] = await Asset.create(
                [
                    {
                        name: trimText(assetPayload.name),
                        machineCode,
                        publicId,
                        serial: trimText(assetPayload.serial),
                        type: trimText(assetPayload.type),
                        model: trimText(assetPayload.model),
                        brandId: assetPayload.brandId,
                        plantId: assetPayload.plantId || batch.plantId,
                        area: trimText(assetPayload.area) || batch.area,
                        note: trimText(assetPayload.note),
                        imageUrl: trimText(assetPayload.imageUrl),
                        purchaseDate: assetPayload.purchaseDate,
                        purchasePrice: assetPayload.purchasePrice,
                        specifications: assetPayload.specifications ?? {},
                        status: ASSET_STATUS.BORROWING,
                        ownershipType,
                        createdBy: userId,
                        updatedBy: userId,
                    },
                ],
                { session }
            );

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

            const [borrowing] = await Borrowing.create(
                [
                    {
                        assetId: asset._id,
                        batchId: batch._id,
                        qrLabelId: label._id,
                        type: batch.type,
                        partnerName: batch.partnerName,
                        partnerMachineCode: trimText(req.body.partnerMachineCode),
                        borrowTime: batch.borrowTime,
                        expectedReturnTime: batch.expectedReturnTime,
                        location: batch.area,
                        purpose: batch.contractNo,
                        note: trimText(batch.note),
                        receiveCondition: trimText(req.body.receiveCondition),
                        receiveNote: trimText(req.body.receiveNote),
                        assetStatusBefore: ASSET_STATUS.ACTIVE,
                        createdBy: userId,
                    },
                ],
                { session }
            );

            createdBorrowingId = String(borrowing._id);
            await refreshBorrowingBatchStatus(String(batch._id), session);
        });
    } finally {
        await session.endSession();
    }

    const item = await borrowingRepository.findById(createdBorrowingId);
    if (!item) throw new NotFoundError('Khong tim thay giao dich vua tao');

    return sendSerializedItem(res, item, serializeBorrowing, 'Da nhan may vao lo bang QR', StatusCodes.CREATED);
};

export const bulkReturnBorrowingBatch = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParamValue(req.params.id);
    const userId = getUserId(req);
    const returnTime = req.body.returnTime;
    const items = req.body.items as Array<{
        borrowingId: string;
        qrReturnAction: string;
        returnCondition?: string;
        returnNote?: string;
        qrReturnNote?: string;
    }>;
    const borrowingIds = items.map((item) => item.borrowingId);
    const itemById = new Map(items.map((item) => [item.borrowingId, item]));
    const session = await mongoose.startSession();
    const returnedIds: string[] = [];

    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo muon / thue');
            if (batch.status === 'cancelled') throw new BadRequestError('Lo muon / thue da bi huy');

            const activeItems = await Borrowing.find({
                _id: { $in: borrowingIds },
                batchId,
                status: 'active',
                isDeleted: { $ne: true },
            }).session(session);

            if (activeItems.length !== borrowingIds.length) {
                throw new BadRequestError('Danh sach tra co may khong thuoc lo nay hoac da duoc tra');
            }

            for (const borrowing of activeItems) {
                const payload = itemById.get(String(borrowing._id));
                if (!payload) continue;

                const qrStatus = getQrRetiredStatus(payload.qrReturnAction);
                const qrRemoved = payload.qrReturnAction === 'removed';

                await Borrowing.updateOne(
                    { _id: borrowing._id, status: 'active', isDeleted: { $ne: true } },
                    {
                        returnTime,
                        returnNote: trimText(payload.returnNote) || trimText(req.body.note),
                        status: 'returned',
                        returnedBy: userId,
                        returnedInBatchAt: new Date(),
                        returnCondition: trimText(payload.returnCondition),
                        qrReturnAction: payload.qrReturnAction,
                        qrReturnNote: trimText(payload.qrReturnNote),
                        qrRemovedAt: qrRemoved ? new Date() : undefined,
                        qrRemovedBy: qrRemoved ? userId : undefined,
                    },
                    { session }
                );

                await Asset.updateOne(
                    { _id: borrowing.assetId },
                    {
                        $set: {
                            status: ASSET_STATUS.RETURNED_TO_PARTNER,
                            ownershipType:
                                borrowing.type === 'rental'
                                    ? ASSET_OWNERSHIP_TYPE.RENTAL
                                    : ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED,
                            updatedBy: userId,
                        },
                        $unset: { publicId: '' },
                    },
                    { session }
                );

                if (borrowing.qrLabelId) {
                    await QrLabel.updateOne(
                        { _id: borrowing.qrLabelId, isDeleted: { $ne: true } },
                        {
                            status: qrStatus,
                            retiredAt: new Date(),
                            retiredBy: userId,
                            retiredReason: buildQrRetiredReason(
                                payload.qrReturnAction,
                                batch.code,
                                trimText(payload.qrReturnNote)
                            ),
                            updatedBy: userId,
                        },
                        { session }
                    );
                }

                returnedIds.push(String(borrowing._id));
            }

            await refreshBorrowingBatchStatus(String(batch._id), session);
        });
    } finally {
        await session.endSession();
    }

    const batch = await applyPopulate(
        BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }),
        WORKFLOW_POPULATE.borrowingBatch
    );
    const [enrichedBatch] = await enrichBorrowingBatches([batch]);
    const refreshedItems = await borrowingRepository.findByBatchId(batchId);

    return sendSuccess(
        res,
        {
            batch: serializeBorrowingBatch(enrichedBatch),
            items: refreshedItems.map(serializeBorrowing),
            returnedIds,
        },
        'Da xac nhan tra nhieu may va xu ly QR tam'
    );
};

export const createBorrowing = async (req: Request, res: Response, next: NextFunction) => {
    const asset = await Asset.findOne({ _id: req.body.assetId, isDeleted: { $ne: true } });

    if (!asset) throw new NotFoundError('Khong tim thay thiet bi');

    if (req.body.type === 'internal') {
        const ownershipType = asset.ownershipType || ASSET_OWNERSHIP_TYPE.OWNED;
        if (ownershipType !== ASSET_OWNERSHIP_TYPE.OWNED || asset.status === ASSET_STATUS.RETURNED_TO_PARTNER) {
            throw new BadRequestError('Chi co the tao giao dich noi bo cho may thuoc Hai Dang');
        }
    }

    const activeTransaction = await borrowingRepository.findActiveByAssetId(req.body.assetId);

    if (activeTransaction) {
        throw new DuplicateError('Thiet bi dang co giao dich muon / thue chua hoan tat');
    }

    const approvedTransfer = await Transfer.findOne({
        assetId: req.body.assetId,
        status: 'approved',
        isDeleted: { $ne: true },
    });
    if (approvedTransfer) {
        throw new BadRequestError('Thiet bi dang trong qua trinh dieu chuyen, khong the tao giao dich');
    }

    const item = await borrowingRepository.create({
        assetId: req.body.assetId,
        type: req.body.type,
        borrowerId: undefined,
        borrowerName: req.body.type === 'internal' ? trimText(req.body.borrowerName) : undefined,
        partnerName: req.body.type === 'internal' ? undefined : trimText(req.body.partnerName),
        borrowTime: req.body.borrowTime,
        purpose: trimText(req.body.purpose),
        location: trimText(req.body.location),
        cost: req.body.type === 'rental' ? req.body.cost : undefined,
        note: trimText(req.body.note),
        assetStatusBefore: asset.status,
        createdBy: req.userId,
    });

    await Asset.findByIdAndUpdate(req.body.assetId, {
        status: ASSET_STATUS.BORROWING,
        ownershipType: getOwnershipTypeForBorrowing(req.body.type),
        updatedBy: req.userId,
    });

    const createdItem = await borrowingRepository.findById(String(item._id));

    if (!createdItem) throw new NotFoundError('Khong tim thay giao dich thiet bi');

    // Send notification to admins about new borrowing
    const assetName = (createdItem.assetId as any)?.name || 'Thiết bị';
    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'info',
            actionType: 'borrowing',
            actionId: String(createdItem._id),
            title: 'Giao dịch mới',
            message: `${actorName} đã tạo giao dịch ${createdItem.type === 'internal' ? 'nội bộ' : 'cho thuê'} cho ${assetName}`,
        },
        { excludeUserIds: [req.userId] }
    );

    return sendSerializedItem(
        res,
        createdItem,
        serializeBorrowing,
        'Tao giao dich thiet bi thanh cong',
        StatusCodes.CREATED
    );
};

export const returnBorrowing = async (req: Request, res: Response, next: NextFunction) => {
    const borrowingId = getParamValue(req.params.id);
    const currentItem = await borrowingRepository.findById(borrowingId);

    if (!currentItem) throw new NotFoundError('Khong tim thay giao dich thiet bi');
    if (currentItem.status !== 'active') {
        throw new BadRequestError('Chi co the tra thiet bi cho giao dich dang hoat dong');
    }

    const item = await borrowingRepository.updateById(borrowingId, {
        returnTime: req.body.returnTime,
        returnNote: trimText(req.body.note),
        status: 'returned',
        returnedBy: req.userId,
    });

    if (!item) throw new NotFoundError('Khong tim thay giao dich thiet bi');

    await Asset.findByIdAndUpdate(toDocumentId(item.assetId), {
        status: isExternalOrRental(item.type)
            ? ASSET_STATUS.RETURNED_TO_PARTNER
            : item.assetStatusBefore === ASSET_STATUS.BORROWING || !item.assetStatusBefore
              ? ASSET_STATUS.ACTIVE
              : item.assetStatusBefore,
        ownershipType: getOwnershipTypeForBorrowing(item.type),
        updatedBy: req.userId,
    });

    // Send notification to admins about returned device
    const assetName = (item.assetId as any)?.name || 'Thiết bị';
    const actorName = await getActorName(req.userId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'success',
            actionType: 'borrowing',
            actionId: String(item._id),
            title: 'Thiết bị đã được trả',
            message: `${actorName} đã xác nhận trả ${assetName} về kho`,
        },
        { excludeUserIds: [req.userId] }
    );

    return sendSerializedItem(res, item, serializeBorrowing, 'Xac nhan tra thiet bi thanh cong');
};
