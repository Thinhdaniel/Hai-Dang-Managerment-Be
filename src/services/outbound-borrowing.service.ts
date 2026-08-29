import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import {
    BORROWING_BATCH_STATUS,
    BORROWING_DIRECTION,
    BORROWING_ITEM_STATUS,
    resolveBorrowingDirection,
} from '@/constant/borrowing';
import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import Borrowing from '@/models/Borrowing';
import BorrowingBatch from '@/models/BorrowingBatch';
import Transfer from '@/models/Transfer';
import User from '@/models/User';
import { ROLE_GROUPS } from '@/constant/permissions';
import { emitToAll } from '@/lib/socket';
import { assetRepository } from '@/repositories/asset.repository';
import { borrowingRepository } from '@/repositories/borrowing.repository';
import { serializeAsset, serializeBorrowing, serializeBorrowingBatch } from '@/utils/serializers';
import { getOutboundHandoverTimelineError } from '@/utils/borrowingTimeline';
import { applyPopulate, sendSuccess, WORKFLOW_POPULATE } from './service.helpers';
import { getActorName, notifyAdmins, notifyUser } from './notification.helper';

const OPEN_TRANSFER_STATUSES = ['pending', 'approved'];
const EDITABLE_BATCH_STATUSES = [BORROWING_BATCH_STATUS.DRAFT, BORROWING_BATCH_STATUS.REJECTED];
const RETURNABLE_ASSET_STATUSES = new Set([ASSET_STATUS.ACTIVE, ASSET_STATUS.STORAGE]);

const getParam = (req: Request, name: string) => {
    const value = req.params[name];
    return Array.isArray(value) ? value[0] : value;
};

const getUserId = (req: Request) =>
    req.userId && mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : undefined;

const toObjectId = (value?: string) => (value ? new mongoose.Types.ObjectId(value) : undefined);

const text = (value?: string | null) => value?.trim() || undefined;

const toId = (value: unknown) =>
    !value
        ? undefined
        : typeof value === 'object' && '_id' in (value as Record<string, unknown>)
          ? String((value as Record<string, unknown>)._id)
          : String(value);

const broadcastAssetChanges = async (assetIds: string[], action: string, changedFields: string[]) => {
    if (!assetIds.length) return;
    const assets = await assetRepository.findMany({ _id: { $in: assetIds } });
    for (const asset of assets) {
        const serializedAsset = serializeAsset(asset);
        emitToAll('asset:updated', {
            action,
            assetId: serializedAsset.id,
            asset: serializedAsset,
            changedFields,
            updatedAt: serializedAsset.updatedAt ?? new Date().toISOString(),
        });
    }
};

const ensureOutboundBatch = (batch: any) => {
    if (resolveBorrowingDirection(batch?.direction, batch?.type) !== BORROWING_DIRECTION.OUTBOUND) {
        throw new BadRequestError('Lo nay khong phai lo Hai Dang cho doi tac muon may');
    }
};

const getOutboundCounts = async (batchId: string, session?: mongoose.ClientSession) => {
    const rows = await Borrowing.aggregate<{ _id: string; count: number }>([
        {
            $match: {
                batchId: new mongoose.Types.ObjectId(batchId),
                isDeleted: { $ne: true },
            },
        },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).session(session ?? null);
    const counts = new Map(rows.map((row) => [String(row._id), row.count]));
    const draftCount = counts.get(BORROWING_ITEM_STATUS.DRAFT) ?? 0;
    const activeCount = counts.get(BORROWING_ITEM_STATUS.ACTIVE) ?? 0;
    const returnedCount = counts.get(BORROWING_ITEM_STATUS.RETURNED) ?? 0;

    return {
        selectedCount: draftCount + activeCount + returnedCount,
        draftCount,
        activeCount,
        returnedCount,
        issuedCount: activeCount + returnedCount,
    };
};

const getDetail = async (batchId: string) => {
    const batch = await applyPopulate(
        BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }),
        WORKFLOW_POPULATE.borrowingBatch
    );
    if (!batch) throw new NotFoundError('Khong tim thay lo cho muon');
    ensureOutboundBatch(batch);

    const [items, counts] = await Promise.all([borrowingRepository.findByBatchId(batchId), getOutboundCounts(batchId)]);
    const plainBatch = typeof batch.toObject === 'function' ? batch.toObject() : batch;

    return {
        batch: serializeBorrowingBatch({ ...plainBatch, ...counts }),
        items: items.map(serializeBorrowing),
    };
};

const notifyDirectors = async (actorId: string | undefined, data: Record<string, unknown>) => {
    const directors = await User.find({
        role: { $in: [...ROLE_GROUPS.DIRECTOR_UP] },
        isDeleted: { $ne: true },
        isActive: true,
    })
        .select('_id')
        .lean();

    await Promise.all(
        directors
            .map((director) => String(director._id))
            .filter((userId) => userId !== actorId)
            .map((userId) => notifyUser(userId, 'notify:new', data))
    );
};

export const addOutboundBorrowingAssets = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const userId = getUserId(req);
    const payloadItems = req.body.items as Array<{
        assetId: string;
        issueCondition?: string;
        issueNote?: string;
        accessories?: string[];
        issueImages?: string[];
    }>;
    const requestedIds = [...new Set(payloadItems.map((item) => item.assetId))];
    if (requestedIds.length !== payloadItems.length) throw new DuplicateError('Danh sach co may bi trung');

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo cho muon');
            ensureOutboundBatch(batch);
            if (!EDITABLE_BATCH_STATUSES.includes(batch.status as BORROWING_BATCH_STATUS)) {
                throw new BadRequestError('Chi co the them may khi lo dang nhap hoac bi tu choi');
            }

            const counts = await getOutboundCounts(batchId, session);
            if (counts.selectedCount + requestedIds.length > Number(batch.plannedQuantity)) {
                throw new BadRequestError('So may duoc chon vuot so luong du kien cua lo');
            }

            const assets = await Asset.find({ _id: { $in: requestedIds }, isDeleted: { $ne: true } }).session(session);
            if (assets.length !== requestedIds.length) throw new NotFoundError('Co may khong ton tai hoac da bi xoa');

            const existingTransactions = await Borrowing.find({
                assetId: { $in: requestedIds },
                status: { $in: [BORROWING_ITEM_STATUS.DRAFT, BORROWING_ITEM_STATUS.ACTIVE] },
                isDeleted: { $ne: true },
            })
                .select('assetId batchId')
                .session(session);
            if (existingTransactions.length) {
                const duplicateIds = existingTransactions.map((item) => String(item.assetId));
                const duplicateCodes = assets
                    .filter((asset) => duplicateIds.includes(String(asset._id)))
                    .map((asset) => asset.machineCode)
                    .join(', ');
                throw new DuplicateError(`May da co giao dich muon/cho muon dang mo: ${duplicateCodes}`);
            }

            const openTransfer = await Transfer.findOne({
                status: { $in: OPEN_TRANSFER_STATUSES },
                isDeleted: { $ne: true },
                $or: [{ assetId: { $in: requestedIds } }, { assetIds: { $in: requestedIds } }],
            })
                .select('assetId assetIds')
                .session(session);
            if (openTransfer) throw new BadRequestError('Co may dang nam trong lenh dieu chuyen chua hoan tat');

            const payloadByAssetId = new Map(payloadItems.map((item) => [item.assetId, item]));
            const invalid: string[] = [];
            for (const asset of assets) {
                const ownershipType = asset.ownershipType || ASSET_OWNERSHIP_TYPE.OWNED;
                const samePlant = String(asset.plantId || '') === String(batch.plantId || '');
                if (
                    ownershipType !== ASSET_OWNERSHIP_TYPE.OWNED ||
                    !RETURNABLE_ASSET_STATUSES.has(asset.status as ASSET_STATUS) ||
                    !samePlant
                ) {
                    invalid.push(asset.machineCode || String(asset._id));
                }
            }
            if (invalid.length) {
                throw new BadRequestError(
                    `Chi duoc cho muon may Hai Dang dang hoat dong/ton kho va thuoc dung co so xuat: ${invalid.join(', ')}`
                );
            }

            await Borrowing.insertMany(
                assets.map((asset) => {
                    const item = payloadByAssetId.get(String(asset._id));
                    return {
                        assetId: asset._id,
                        batchId: batch._id,
                        type: 'external',
                        direction: BORROWING_DIRECTION.OUTBOUND,
                        status: BORROWING_ITEM_STATUS.DRAFT,
                        partnerName: batch.partnerName,
                        borrowTime: batch.borrowTime,
                        expectedReturnTime: batch.expectedReturnTime,
                        purpose: batch.purpose,
                        location: batch.partnerAddress,
                        note: text(batch.note),
                        issueCondition: text(item?.issueCondition),
                        issueNote: text(item?.issueNote),
                        accessories: item?.accessories?.map((value) => value.trim()).filter(Boolean) ?? [],
                        issueImages: item?.issueImages ?? [],
                        assetStatusBefore: asset.status,
                        assetOwnershipTypeBefore: asset.ownershipType || ASSET_OWNERSHIP_TYPE.OWNED,
                        assetPlantIdBefore: asset.plantId,
                        assetAreaBefore: asset.area,
                        createdBy: userId,
                    };
                }),
                { session, ordered: true }
            );

            batch.status = BORROWING_BATCH_STATUS.DRAFT;
            batch.rejectedBy = undefined;
            batch.rejectedAt = undefined;
            batch.rejectReason = undefined;
            batch.updatedBy = toObjectId(userId);
            await batch.save({ session });
        });
    } finally {
        await session.endSession();
    }

    return sendSuccess(res, await getDetail(batchId), 'Da them may vao lo cho muon', StatusCodes.CREATED);
};

export const removeOutboundBorrowingAsset = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const itemId = getParam(req, 'itemId');
    const userId = getUserId(req);
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo cho muon');
            ensureOutboundBatch(batch);
            if (!EDITABLE_BATCH_STATUSES.includes(batch.status as BORROWING_BATCH_STATUS)) {
                throw new BadRequestError('Khong the xoa may sau khi lo da gui duyet');
            }

            const deleted = await Borrowing.findOneAndUpdate(
                {
                    _id: itemId,
                    batchId,
                    direction: BORROWING_DIRECTION.OUTBOUND,
                    status: BORROWING_ITEM_STATUS.DRAFT,
                    isDeleted: { $ne: true },
                },
                {
                    $set: {
                        status: BORROWING_ITEM_STATUS.CANCELLED,
                        isDeleted: true,
                        deletedAt: new Date(),
                    },
                },
                { session, returnDocument: 'after' }
            );
            if (!deleted) throw new NotFoundError('Khong tim thay may nhap trong lo');

            batch.updatedBy = toObjectId(userId);
            await batch.save({ session });
        });
    } finally {
        await session.endSession();
    }

    return sendSuccess(res, await getDetail(batchId), 'Da xoa may khoi lo cho muon');
};

export const submitOutboundBorrowingBatch = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const userId = getUserId(req);
    const session = await mongoose.startSession();
    let submittedCode = '';
    let submittedPartner = '';
    let submittedCount = 0;
    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo cho muon');
            ensureOutboundBatch(batch);
            if (!EDITABLE_BATCH_STATUSES.includes(batch.status as BORROWING_BATCH_STATUS)) {
                throw new BadRequestError('Lo khong o trang thai co the gui duyet');
            }

            const counts = await getOutboundCounts(batchId, session);
            if (!counts.selectedCount) throw new BadRequestError('Can them it nhat mot may truoc khi gui duyet');
            if (counts.selectedCount !== Number(batch.plannedQuantity)) {
                throw new BadRequestError(
                    `Danh sach hien co ${counts.selectedCount} may, khong khop so luong du kien ${batch.plannedQuantity}`
                );
            }

            batch.status = BORROWING_BATCH_STATUS.PENDING_APPROVAL;
            batch.submittedBy = toObjectId(userId);
            batch.submittedAt = new Date();
            batch.rejectedBy = undefined;
            batch.rejectedAt = undefined;
            batch.rejectReason = undefined;
            batch.updatedBy = toObjectId(userId);
            await batch.save({ session });

            submittedCode = batch.code;
            submittedPartner = batch.partnerName;
            submittedCount = counts.selectedCount;
        });
    } finally {
        await session.endSession();
    }

    const actorName = await getActorName(userId);
    await notifyDirectors(userId, {
        type: 'warning',
        actionType: 'borrowing',
        actionId: batchId,
        title: 'Lô cho mượn máy chờ duyệt',
        message: `${actorName} gửi duyệt lô ${submittedCode}: ${submittedCount} máy cho ${submittedPartner}`,
    });

    return sendSuccess(res, await getDetail(batchId), 'Da gui lo cho muon cho giam doc duyet');
};

export const approveOutboundBorrowingBatch = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const userId = getUserId(req);
    const currentBatch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } });
    if (!currentBatch) throw new NotFoundError('Khong tim thay lo cho muon');
    ensureOutboundBatch(currentBatch);

    const batch = await BorrowingBatch.findOneAndUpdate(
        {
            _id: batchId,
            status: BORROWING_BATCH_STATUS.PENDING_APPROVAL,
            isDeleted: { $ne: true },
        },
        {
            $set: {
                status: BORROWING_BATCH_STATUS.APPROVED,
                approvedBy: toObjectId(userId),
                approvedAt: new Date(),
                updatedBy: toObjectId(userId),
            },
        },
        { returnDocument: 'after', runValidators: true }
    );
    if (!batch) {
        throw new BadRequestError('Chi co the duyet lo dang cho duyet');
    }

    const creatorId = toId(batch.createdBy);
    if (creatorId && creatorId !== userId) {
        await notifyUser(creatorId, 'notify:new', {
            type: 'success',
            actionType: 'borrowing',
            actionId: batchId,
            title: 'Lô cho mượn đã được duyệt',
            message: `Lô ${batch.code} cho ${batch.partnerName} đã được duyệt, có thể bàn giao máy.`,
        });
    }

    return sendSuccess(res, await getDetail(batchId), 'Da duyet lo cho muon');
};

export const rejectOutboundBorrowingBatch = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const userId = getUserId(req);
    const currentBatch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } });
    if (!currentBatch) throw new NotFoundError('Khong tim thay lo cho muon');
    ensureOutboundBatch(currentBatch);

    const rejectReason = text(req.body.reason);
    const batch = await BorrowingBatch.findOneAndUpdate(
        {
            _id: batchId,
            status: BORROWING_BATCH_STATUS.PENDING_APPROVAL,
            isDeleted: { $ne: true },
        },
        {
            $set: {
                status: BORROWING_BATCH_STATUS.REJECTED,
                rejectedBy: toObjectId(userId),
                rejectedAt: new Date(),
                rejectReason,
                updatedBy: toObjectId(userId),
            },
        },
        { returnDocument: 'after', runValidators: true }
    );
    if (!batch) {
        throw new BadRequestError('Chi co the tu choi lo dang cho duyet');
    }

    const creatorId = toId(batch.createdBy);
    if (creatorId && creatorId !== userId) {
        await notifyUser(creatorId, 'notify:new', {
            type: 'error',
            actionType: 'borrowing',
            actionId: batchId,
            title: 'Lô cho mượn bị từ chối',
            message: `Lô ${batch.code} bị từ chối: ${batch.rejectReason}`,
        });
    }

    return sendSuccess(res, await getDetail(batchId), 'Da tu choi lo cho muon');
};

export const confirmOutboundHandover = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const userId = getUserId(req);
    const handoverTime = new Date(req.body.handoverTime);
    const session = await mongoose.startSession();
    let affectedAssetIds: string[] = [];

    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo cho muon');
            ensureOutboundBatch(batch);
            if (batch.status !== BORROWING_BATCH_STATUS.APPROVED) {
                throw new BadRequestError('Lo phai duoc duyet truoc khi ban giao may');
            }

            // The workflow is approved now, but the physical handover may be recorded retrospectively.
            const timelineError = getOutboundHandoverTimelineError({
                handoverTime,
                expectedReturnTime: batch.expectedReturnTime,
            });
            if (timelineError) throw new BadRequestError(timelineError);

            const items = await Borrowing.find({
                batchId,
                direction: BORROWING_DIRECTION.OUTBOUND,
                status: BORROWING_ITEM_STATUS.DRAFT,
                isDeleted: { $ne: true },
            }).session(session);
            if (!items.length) throw new BadRequestError('Lo khong co may cho ban giao');
            if (items.length !== Number(batch.plannedQuantity)) {
                throw new BadRequestError('So may ban giao khong khop so luong da duyet');
            }
            affectedAssetIds = items
                .map((item) => toId(item.assetId))
                .filter((value): value is string => Boolean(value));

            const openTransfer = await Transfer.findOne({
                status: { $in: OPEN_TRANSFER_STATUSES },
                isDeleted: { $ne: true },
                $or: [{ assetId: { $in: affectedAssetIds } }, { assetIds: { $in: affectedAssetIds } }],
            })
                .select('_id')
                .session(session);
            if (openTransfer) {
                throw new BadRequestError('Co may dang nam trong lenh dieu chuyen; can huy lenh truoc khi ban giao');
            }

            for (const item of items) {
                const assetUpdate = await Asset.updateOne(
                    {
                        _id: item.assetId,
                        isDeleted: { $ne: true },
                        $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                        plantId: batch.plantId,
                        status: item.assetStatusBefore,
                    },
                    {
                        $set: {
                            status: ASSET_STATUS.LOANED_OUT,
                            ownershipType: ASSET_OWNERSHIP_TYPE.OWNED,
                            updatedBy: userId,
                        },
                    },
                    { session }
                );
                if (assetUpdate.modifiedCount !== 1) {
                    throw new BadRequestError('Trang thai/vi tri mot may da thay doi, vui long kiem tra lai lo');
                }
            }

            await Borrowing.updateMany(
                {
                    batchId,
                    direction: BORROWING_DIRECTION.OUTBOUND,
                    status: BORROWING_ITEM_STATUS.DRAFT,
                    isDeleted: { $ne: true },
                },
                {
                    $set: {
                        status: BORROWING_ITEM_STATUS.ACTIVE,
                        borrowTime: handoverTime,
                    },
                },
                { session }
            );

            batch.status = BORROWING_BATCH_STATUS.ACTIVE;
            batch.borrowTime = handoverTime;
            batch.handedOverBy = toObjectId(userId);
            batch.handedOverAt = handoverTime;
            batch.handoverImages = req.body.handoverImages ?? [];
            if (text(req.body.note)) batch.note = text(req.body.note);
            batch.updatedBy = toObjectId(userId);
            await batch.save({ session });
        });
    } finally {
        await session.endSession();
    }

    await broadcastAssetChanges(affectedAssetIds, 'outbound-borrowing-handed-over', ['status']);
    const detail = await getDetail(batchId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'info',
            actionType: 'borrowing',
            actionId: batchId,
            title: 'Đã bàn giao máy cho đối tác',
            message: `${detail.batch.code}: đã giao ${detail.batch.activeCount} máy cho ${detail.batch.partnerName}.`,
        },
        { excludeUserIds: [userId] }
    );
    return sendSuccess(res, detail, 'Da xac nhan ban giao may cho doi tac');
};

export const returnOutboundBorrowingBatch = async (
    req: Request,
    res: Response,
    batch: any,
    itemsPayload: Array<{
        borrowingId: string;
        returnCondition?: string;
        returnNote?: string;
        returnImages?: string[];
    }>
) => {
    const batchId = String(batch._id);
    const userId = getUserId(req);
    const returnTime = new Date(req.body.returnTime);
    if (returnTime.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new BadRequestError('Thoi gian nhan lai khong duoc nam trong tuong lai');
    }
    const handoverTime = new Date(batch.handedOverAt || batch.borrowTime);
    if (Number.isFinite(handoverTime.getTime()) && returnTime < handoverTime) {
        throw new BadRequestError('Thoi gian nhan lai phai sau thoi gian ban giao');
    }
    const itemById = new Map(itemsPayload.map((item) => [item.borrowingId, item]));
    const ids = itemsPayload.map((item) => item.borrowingId);
    if (new Set(ids).size !== ids.length) throw new DuplicateError('Danh sach nhan lai co may bi trung');
    const session = await mongoose.startSession();
    let affectedAssetIds: string[] = [];

    try {
        await session.withTransaction(async () => {
            const currentBatch = await BorrowingBatch.findOne({
                _id: batchId,
                direction: BORROWING_DIRECTION.OUTBOUND,
                status: { $in: [BORROWING_BATCH_STATUS.ACTIVE, BORROWING_BATCH_STATUS.PARTIALLY_RETURNED] },
                isDeleted: { $ne: true },
            }).session(session);
            if (!currentBatch) {
                throw new BadRequestError('Lo khong o trang thai co the nhan lai may');
            }

            const activeItems = await Borrowing.find({
                _id: { $in: ids },
                batchId,
                direction: BORROWING_DIRECTION.OUTBOUND,
                status: BORROWING_ITEM_STATUS.ACTIVE,
                isDeleted: { $ne: true },
            }).session(session);
            if (activeItems.length !== ids.length) {
                throw new BadRequestError('Danh sach nhan lai co may khong thuoc lo hoac da duoc nhan');
            }
            affectedAssetIds = activeItems
                .map((item) => toId(item.assetId))
                .filter((value): value is string => Boolean(value));

            for (const borrowing of activeItems) {
                const payload = itemById.get(String(borrowing._id));
                if (!payload) continue;
                const restoredStatus = RETURNABLE_ASSET_STATUSES.has(borrowing.assetStatusBefore as ASSET_STATUS)
                    ? borrowing.assetStatusBefore
                    : ASSET_STATUS.ACTIVE;

                const assetUpdate = await Asset.updateOne(
                    {
                        _id: borrowing.assetId,
                        status: ASSET_STATUS.LOANED_OUT,
                        ownershipType: ASSET_OWNERSHIP_TYPE.OWNED,
                        isDeleted: { $ne: true },
                    },
                    {
                        $set: {
                            status: restoredStatus,
                            ownershipType: ASSET_OWNERSHIP_TYPE.OWNED,
                            plantId: borrowing.assetPlantIdBefore,
                            area: borrowing.assetAreaBefore,
                            updatedBy: userId,
                        },
                    },
                    { session }
                );
                if (assetUpdate.modifiedCount !== 1) {
                    throw new BadRequestError('May khong con o trang thai dang cho muon, khong the nhan lai');
                }

                await Borrowing.updateOne(
                    { _id: borrowing._id, status: BORROWING_ITEM_STATUS.ACTIVE },
                    {
                        $set: {
                            status: BORROWING_ITEM_STATUS.RETURNED,
                            returnTime,
                            returnedInBatchAt: new Date(),
                            returnedBy: userId,
                            returnCondition: text(payload.returnCondition),
                            returnNote: text(payload.returnNote) || text(req.body.note),
                            returnImages: payload.returnImages ?? [],
                        },
                    },
                    { session }
                );
            }

            const remaining = await Borrowing.countDocuments({
                batchId,
                direction: BORROWING_DIRECTION.OUTBOUND,
                status: BORROWING_ITEM_STATUS.ACTIVE,
                isDeleted: { $ne: true },
            }).session(session);
            const returned = await Borrowing.countDocuments({
                batchId,
                direction: BORROWING_DIRECTION.OUTBOUND,
                status: BORROWING_ITEM_STATUS.RETURNED,
                isDeleted: { $ne: true },
            }).session(session);

            const batchUpdate: Record<string, unknown> = {
                $set: {
                    status:
                        remaining === 0 && returned > 0
                            ? BORROWING_BATCH_STATUS.RETURNED
                            : BORROWING_BATCH_STATUS.PARTIALLY_RETURNED,
                    updatedBy: userId,
                    ...(remaining === 0 ? { closedAt: new Date(), closedBy: userId } : {}),
                },
            };
            if (remaining > 0) batchUpdate.$unset = { closedAt: 1, closedBy: 1 };

            await BorrowingBatch.updateOne({ _id: batchId }, batchUpdate, { session });
        });
    } finally {
        await session.endSession();
    }

    await broadcastAssetChanges(affectedAssetIds, 'outbound-borrowing-returned', ['status', 'plantId', 'area']);
    const detail = await getDetail(batchId);
    await notifyAdmins(
        'notify:new',
        {
            type: 'success',
            actionType: 'borrowing',
            actionId: batchId,
            title: 'Đã nhận lại máy cho mượn',
            message: `${detail.batch.code}: nhận lại ${ids.length} máy, còn ${detail.batch.activeCount} máy ở đối tác.`,
        },
        { excludeUserIds: [userId] }
    );

    return sendSuccess(res, { ...detail, returnedIds: ids }, 'Da nhan lai may tu doi tac');
};

export const cancelOutboundBorrowingBatch = async (req: Request, res: Response, next: NextFunction) => {
    const batchId = getParam(req, 'id');
    const userId = getUserId(req);
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const batch = await BorrowingBatch.findOne({ _id: batchId, isDeleted: { $ne: true } }).session(session);
            if (!batch) throw new NotFoundError('Khong tim thay lo cho muon');
            ensureOutboundBatch(batch);
            if (
                ![
                    BORROWING_BATCH_STATUS.DRAFT,
                    BORROWING_BATCH_STATUS.REJECTED,
                    BORROWING_BATCH_STATUS.PENDING_APPROVAL,
                    BORROWING_BATCH_STATUS.APPROVED,
                ].includes(batch.status as BORROWING_BATCH_STATUS)
            ) {
                throw new BadRequestError('Khong the huy lo sau khi da ban giao may');
            }

            await Borrowing.updateMany(
                {
                    batchId,
                    direction: BORROWING_DIRECTION.OUTBOUND,
                    status: BORROWING_ITEM_STATUS.DRAFT,
                    isDeleted: { $ne: true },
                },
                { $set: { status: BORROWING_ITEM_STATUS.CANCELLED } },
                { session }
            );
            batch.status = BORROWING_BATCH_STATUS.CANCELLED;
            batch.closedBy = toObjectId(userId);
            batch.closedAt = new Date();
            batch.note = [text(batch.note), `Hủy: ${text(req.body.reason)}`].filter(Boolean).join(' | ');
            batch.updatedBy = toObjectId(userId);
            await batch.save({ session });
        });
    } finally {
        await session.endSession();
    }

    return sendSuccess(res, await getDetail(batchId), 'Da huy lo cho muon');
};
