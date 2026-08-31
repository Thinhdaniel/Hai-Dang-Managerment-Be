import mongoose from 'mongoose';
import {
    BORROWING_BATCH_STATUS,
    BORROWING_DIRECTION,
    BORROWING_ITEM_STATUS,
    resolveBorrowingDirection,
} from '@/constant/borrowing';
import Asset from '@/models/Asset';
import Borrowing from '@/models/Borrowing';
import BorrowingBatch from '@/models/BorrowingBatch';
import { addVietnamDays, endOfVietnamDay, startOfVietnamDay, vietnamCalendarParts } from '@/utils/vietnamDate';

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'all';
type Direction = 'all' | BORROWING_DIRECTION.INBOUND | BORROWING_DIRECTION.OUTBOUND;
type DueState = 'overdue' | 'due_soon' | 'missing_due';

export type BorrowingInsightArgs = {
    direction?: Direction;
    status?: 'open' | BORROWING_BATCH_STATUS;
    dueState?: DueState;
    partnerName?: string;
    batchCode?: string;
    machineRef?: string;
    plantName?: string;
    period?: Period;
    startDate?: string;
    endDate?: string;
    limit?: number;
    _resolvedPlantId?: string;
};

const OPEN_BATCH_STATUSES = [
    BORROWING_BATCH_STATUS.DRAFT,
    BORROWING_BATCH_STATUS.RECEIVING,
    BORROWING_BATCH_STATUS.PENDING_APPROVAL,
    BORROWING_BATCH_STATUS.APPROVED,
    BORROWING_BATCH_STATUS.ACTIVE,
    BORROWING_BATCH_STATUS.PARTIALLY_RETURNED,
];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clampLimit = (value?: number) => Math.min(Math.max(Number(value) || 12, 1), 30);
const objectId = (value: unknown) =>
    value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
const populatedName = (value: any) =>
    value && typeof value === 'object' ? String(value.name || value.code || '') : undefined;

const periodRange = (args: BorrowingInsightArgs) => {
    const display = (value: string) => value.split('-').reverse().join('/');
    if (args.startDate || args.endDate) {
        const from = args.startDate || args.endDate!;
        const to = args.endDate || args.startDate!;
        return {
            start: new Date(`${from}T00:00:00.000+07:00`),
            end: new Date(`${to}T23:59:59.999+07:00`),
            label: from === to ? `ngày ${display(from)}` : `từ ${display(from)} đến ${display(to)}`,
        };
    }

    const now = new Date();
    if (args.period === 'today') {
        return { start: startOfVietnamDay(now), end: endOfVietnamDay(now), label: 'hôm nay' };
    }
    if (args.period === 'yesterday') {
        const yesterday = addVietnamDays(now, -1);
        return { start: startOfVietnamDay(yesterday), end: endOfVietnamDay(yesterday), label: 'hôm qua' };
    }
    if (args.period === 'week') {
        const weekday = vietnamCalendarParts(now).weekday || 7;
        const start = startOfVietnamDay(addVietnamDays(now, -weekday + 1));
        return { start, end: endOfVietnamDay(addVietnamDays(start, 6)), label: 'tuần này' };
    }
    if (args.period === 'month') {
        const { year, month } = vietnamCalendarParts(now);
        return {
            start: new Date(Date.UTC(year, month, 1) - 7 * 60 * 60 * 1000),
            end: new Date(Date.UTC(year, month + 1, 1) - 7 * 60 * 60 * 1000 - 1),
            label: `tháng ${String(month + 1).padStart(2, '0')}/${year}`,
        };
    }
    return { start: undefined, end: undefined, label: args.period === 'all' ? 'toàn bộ thời gian' : 'hiện tại' };
};

const directionCondition = (direction?: Direction) => {
    if (direction === BORROWING_DIRECTION.OUTBOUND) return { direction: BORROWING_DIRECTION.OUTBOUND };
    if (direction === BORROWING_DIRECTION.INBOUND) {
        return {
            $or: [
                { direction: BORROWING_DIRECTION.INBOUND },
                { direction: { $exists: false }, type: { $in: ['external', 'rental'] } },
            ],
        };
    }
    return undefined;
};

const directionLabel = (direction: string) =>
    direction === BORROWING_DIRECTION.OUTBOUND ? 'Hải Đăng cho đối tác mượn' : 'Hải Đăng mượn/thuê của đối tác';

const statusLabel: Record<string, string> = {
    draft: 'Bản nháp',
    receiving: 'Đang tiếp nhận',
    pending_approval: 'Chờ duyệt',
    approved: 'Đã duyệt, chờ giao',
    active: 'Đang mượn/cho mượn',
    partially_returned: 'Đã trả một phần',
    returned: 'Đã trả đủ',
    rejected: 'Từ chối',
    cancelled: 'Đã hủy',
};

const dueInfo = (expectedReturnTime: unknown, activeCount: number, now: Date) => {
    if (!expectedReturnTime || activeCount <= 0) {
        return { overdue: false, dueSoon: false, daysToDue: undefined };
    }
    const due = new Date(String(expectedReturnTime));
    const daysToDue = Math.ceil((due.getTime() - now.getTime()) / 86400000);
    return { overdue: daysToDue < 0, dueSoon: daysToDue >= 0 && daysToDue <= 7, daysToDue };
};

export const borrowingInsight = async (args: BorrowingInsightArgs = {}) => {
    const now = new Date();
    const limit = clampLimit(args.limit);
    const range = periodRange(args);
    const and: Record<string, any>[] = [];
    const batchFilter: Record<string, any> = { isDeleted: { $ne: true } };
    const direction = directionCondition(args.direction);
    if (direction) and.push(direction);

    const explicitHistory = Boolean(args.period || args.startDate || args.endDate || args.batchCode || args.machineRef);
    if (args.status === 'open' || (!args.status && !explicitHistory)) {
        batchFilter.status = { $in: OPEN_BATCH_STATUSES };
    } else if (args.status) {
        batchFilter.status = args.status;
    }
    if (args._resolvedPlantId) batchFilter.plantId = objectId(args._resolvedPlantId);
    if (args.partnerName) batchFilter.partnerName = new RegExp(escapeRegex(args.partnerName), 'i');
    if (args.batchCode) batchFilter.code = new RegExp(escapeRegex(args.batchCode), 'i');
    if (range.start || range.end) {
        batchFilter.borrowTime = {};
        if (range.start) batchFilter.borrowTime.$gte = range.start;
        if (range.end) batchFilter.borrowTime.$lte = range.end;
    }

    if (args.dueState === 'overdue') {
        batchFilter.expectedReturnTime = { $lt: now };
        batchFilter.status = { $in: [BORROWING_BATCH_STATUS.ACTIVE, BORROWING_BATCH_STATUS.PARTIALLY_RETURNED] };
    } else if (args.dueState === 'due_soon') {
        batchFilter.expectedReturnTime = { $gte: now, $lte: addVietnamDays(now, 7) };
        batchFilter.status = { $in: [BORROWING_BATCH_STATUS.ACTIVE, BORROWING_BATCH_STATUS.PARTIALLY_RETURNED] };
    } else if (args.dueState === 'missing_due') {
        and.push({ $or: [{ expectedReturnTime: { $exists: false } }, { expectedReturnTime: null }] });
        batchFilter.status = { $in: OPEN_BATCH_STATUSES };
    }

    let matchedAssetIds: mongoose.Types.ObjectId[] | undefined;
    if (args.machineRef) {
        const regex = new RegExp(escapeRegex(args.machineRef), 'i');
        matchedAssetIds = await Asset.find({
            isDeleted: { $ne: true },
            $or: [{ machineCode: regex }, { serial: regex }, { name: regex }],
        })
            .distinct('_id')
            .then((ids) => ids.map(objectId));
        const transactionBatchIds = await Borrowing.find({
            isDeleted: { $ne: true },
            $or: [{ assetId: { $in: matchedAssetIds } }, { partnerMachineCode: regex }],
            batchId: { $exists: true, $ne: null },
        }).distinct('batchId');
        batchFilter._id = { $in: transactionBatchIds.map(objectId) };
    }
    let plantAssetIds: mongoose.Types.ObjectId[] | undefined;
    if (args._resolvedPlantId) {
        plantAssetIds = await Asset.find({
            isDeleted: { $ne: true },
            plantId: objectId(args._resolvedPlantId),
        })
            .distinct('_id')
            .then((ids) => ids.map(objectId));
    }
    if (and.length) batchFilter.$and = and;

    const batches = await BorrowingBatch.find(batchFilter)
        .select(
            'code type direction status partnerName contractNo purpose plantId area borrowTime expectedReturnTime plannedQuantity submittedAt approvedAt handedOverAt createdAt'
        )
        .populate('plantId', 'name code')
        .sort('-borrowTime -createdAt')
        .limit(200)
        .lean();
    const batchIds = batches.map((batch: any) => objectId(batch._id));

    const itemAnd: Record<string, any>[] = [];
    const itemDirection = directionCondition(args.direction);
    if (itemDirection) itemAnd.push(itemDirection);
    const itemBranches: Record<string, any>[] = [{ batchId: { $in: batchIds } }];
    const standaloneStatus =
        args.status === 'open' || args.status === BORROWING_BATCH_STATUS.ACTIVE || (!args.status && !explicitHistory)
            ? BORROWING_ITEM_STATUS.ACTIVE
            : args.status === BORROWING_BATCH_STATUS.RETURNED
              ? BORROWING_ITEM_STATUS.RETURNED
              : args.status === BORROWING_BATCH_STATUS.DRAFT
                ? BORROWING_ITEM_STATUS.DRAFT
                : args.status === BORROWING_BATCH_STATUS.CANCELLED
                  ? BORROWING_ITEM_STATUS.CANCELLED
                  : undefined;
    const standaloneAllowed =
        !args.batchCode &&
        (!args.status ||
            args.status === 'open' ||
            [
                BORROWING_BATCH_STATUS.DRAFT,
                BORROWING_BATCH_STATUS.ACTIVE,
                BORROWING_BATCH_STATUS.RETURNED,
                BORROWING_BATCH_STATUS.CANCELLED,
            ].includes(args.status as BORROWING_BATCH_STATUS));
    if (standaloneAllowed) {
        const standaloneAnd: Record<string, any>[] = [{ $or: [{ batchId: { $exists: false } }, { batchId: null }] }];
        if (standaloneStatus) standaloneAnd.push({ status: standaloneStatus });
        if (args.partnerName) standaloneAnd.push({ partnerName: new RegExp(escapeRegex(args.partnerName), 'i') });
        if (range.start || range.end) {
            const borrowTime: Record<string, Date> = {};
            if (range.start) borrowTime.$gte = range.start;
            if (range.end) borrowTime.$lte = range.end;
            standaloneAnd.push({ borrowTime });
        }
        if (plantAssetIds) standaloneAnd.push({ assetId: { $in: plantAssetIds } });
        if (args.dueState === 'overdue') {
            standaloneAnd.push({ expectedReturnTime: { $lt: now }, status: BORROWING_ITEM_STATUS.ACTIVE });
        } else if (args.dueState === 'due_soon') {
            standaloneAnd.push({
                expectedReturnTime: { $gte: now, $lte: addVietnamDays(now, 7) },
                status: BORROWING_ITEM_STATUS.ACTIVE,
            });
        } else if (args.dueState === 'missing_due') {
            standaloneAnd.push({
                $or: [{ expectedReturnTime: { $exists: false } }, { expectedReturnTime: null }],
            });
        }
        itemBranches.push({ $and: standaloneAnd });
    }
    const itemFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        type: { $in: ['external', 'rental'] },
        $or: itemBranches,
    };
    if (matchedAssetIds) {
        const regex = new RegExp(escapeRegex(args.machineRef!), 'i');
        itemAnd.push({ $or: [{ assetId: { $in: matchedAssetIds } }, { partnerMachineCode: regex }] });
    }
    if (itemAnd.length) itemFilter.$and = itemAnd;

    const items = await Borrowing.find(itemFilter)
        .select(
            'assetId batchId type direction status partnerName partnerMachineCode borrowTime returnTime expectedReturnTime purpose location issueCondition returnCondition createdAt'
        )
        .populate({
            path: 'assetId',
            select: 'machineCode name serial plantId area',
            populate: { path: 'plantId', select: 'name code' },
        })
        .populate({
            path: 'batchId',
            select: 'code direction status partnerName plantId expectedReturnTime purpose',
            populate: { path: 'plantId', select: 'name code' },
        })
        .sort('-borrowTime -createdAt')
        .lean();

    const countByBatch = new Map<string, { draft: number; active: number; returned: number; cancelled: number }>();
    for (const item of items as any[]) {
        const key = String(item.batchId?._id || item.batchId || '');
        const counts = countByBatch.get(key) || { draft: 0, active: 0, returned: 0, cancelled: 0 };
        if (item.status in counts) counts[item.status as keyof typeof counts] += 1;
        countByBatch.set(key, counts);
    }

    const mappedBatches = batches.map((batch: any) => {
        const resolvedDirection = resolveBorrowingDirection(batch.direction, batch.type);
        const counts = countByBatch.get(String(batch._id)) || { draft: 0, active: 0, returned: 0, cancelled: 0 };
        const due = dueInfo(batch.expectedReturnTime, counts.active, now);
        return {
            id: String(batch._id),
            code: batch.code,
            direction: resolvedDirection,
            directionLabel: directionLabel(resolvedDirection),
            status: batch.status,
            statusLabel: statusLabel[batch.status] || batch.status,
            partner: batch.partnerName,
            plant: populatedName(batch.plantId),
            area: batch.area,
            purpose: batch.purpose,
            contractNo: batch.contractNo,
            borrowTime: batch.borrowTime,
            expectedReturnTime: batch.expectedReturnTime,
            plannedQuantity: Number(batch.plannedQuantity || 0),
            selectedCount: counts.draft + counts.active + counts.returned,
            waitingHandoverCount: counts.draft,
            activeCount: counts.active,
            returnedCount: counts.returned,
            overdue: due.overdue,
            dueSoon: due.dueSoon,
            daysToDue: due.daysToDue,
            submittedAt: batch.submittedAt,
            approvedAt: batch.approvedAt,
            handedOverAt: batch.handedOverAt,
        };
    });

    const mappedItems = (items as any[]).map((item) => {
        const batch = item.batchId && typeof item.batchId === 'object' ? item.batchId : undefined;
        const asset = item.assetId && typeof item.assetId === 'object' ? item.assetId : undefined;
        const resolvedDirection = resolveBorrowingDirection(item.direction, item.type);
        const effectiveDue = item.expectedReturnTime || batch?.expectedReturnTime;
        const due = dueInfo(effectiveDue, item.status === BORROWING_ITEM_STATUS.ACTIVE ? 1 : 0, now);
        return {
            id: String(item._id),
            machineCode: asset?.machineCode || item.partnerMachineCode || 'Chưa có mã',
            name: asset?.name || 'Máy đối tác',
            serial: asset?.serial,
            plantName: populatedName(asset?.plantId) || populatedName(batch?.plantId),
            area: asset?.area || item.location,
            batchCode: batch?.code,
            partner: item.partnerName || batch?.partnerName || 'Chưa xác định',
            direction: resolvedDirection,
            directionLabel: directionLabel(resolvedDirection),
            status: item.status,
            statusLabel:
                item.status === BORROWING_ITEM_STATUS.ACTIVE
                    ? resolvedDirection === BORROWING_DIRECTION.OUTBOUND
                        ? 'Đang cho mượn'
                        : 'Đang mượn/thuê'
                    : item.status === BORROWING_ITEM_STATUS.RETURNED
                      ? 'Đã trả'
                      : item.status === BORROWING_ITEM_STATUS.DRAFT
                        ? 'Chờ giao'
                        : 'Đã hủy',
            borrowTime: item.borrowTime,
            returnTime: item.returnTime,
            expectedReturnTime: effectiveDue,
            overdue: due.overdue,
            dueSoon: due.dueSoon,
            daysToDue: due.daysToDue,
            purpose: item.purpose || batch?.purpose,
            issueCondition: item.issueCondition,
            returnCondition: item.returnCondition,
            mislocated: false,
        };
    });

    const activeItems = mappedItems.filter((item) => item.status === BORROWING_ITEM_STATUS.ACTIVE);
    const returnedItems = mappedItems.filter((item) => item.status === BORROWING_ITEM_STATUS.RETURNED);
    const draftItems = mappedItems.filter((item) => item.status === BORROWING_ITEM_STATUS.DRAFT);
    const partners = new Map<
        string,
        { partner: string; inboundActive: number; outboundActive: number; total: number }
    >();
    for (const item of mappedItems) {
        const row = partners.get(item.partner) || {
            partner: item.partner,
            inboundActive: 0,
            outboundActive: 0,
            total: 0,
        };
        row.total += 1;
        if (item.status === BORROWING_ITEM_STATUS.ACTIVE) {
            if (item.direction === BORROWING_DIRECTION.OUTBOUND) row.outboundActive += 1;
            else row.inboundActive += 1;
        }
        partners.set(item.partner, row);
    }

    const directionScope =
        args.direction === BORROWING_DIRECTION.OUTBOUND
            ? 'máy Hải Đăng cho đối tác mượn'
            : args.direction === BORROWING_DIRECTION.INBOUND
              ? 'máy Hải Đăng mượn/thuê của đối tác'
              : 'cả máy mượn/thuê vào và máy cho đối tác mượn';
    return {
        scope: {
            label: `${directionScope}, ${range.label}`,
            direction: args.direction || 'all',
            period: range.label,
            status: args.status || (explicitHistory ? 'all' : 'open'),
            dueState: args.dueState,
            plantName: args.plantName,
            partnerName: args.partnerName,
            batchCode: args.batchCode,
            machineRef: args.machineRef,
        },
        summary: {
            batchCount: mappedBatches.length,
            machineRecordCount: mappedItems.length,
            waitingHandoverMachines: draftItems.length,
            activeMachines: activeItems.length,
            returnedMachines: returnedItems.length,
            inboundActiveMachines: activeItems.filter((item) => item.direction === BORROWING_DIRECTION.INBOUND).length,
            outboundActiveMachines: activeItems.filter((item) => item.direction === BORROWING_DIRECTION.OUTBOUND)
                .length,
            overdueMachines: activeItems.filter((item) => item.overdue).length,
            dueSoonMachines: activeItems.filter((item) => item.dueSoon).length,
        },
        byBatchStatus: Object.entries(
            mappedBatches.reduce<Record<string, number>>((acc, batch) => {
                acc[batch.statusLabel] = (acc[batch.statusLabel] || 0) + 1;
                return acc;
            }, {})
        ).map(([label, count]) => ({ label, count })),
        partners: [...partners.values()].sort((a, b) => b.total - a.total),
        batches: mappedBatches.slice(0, limit),
        machines: mappedItems.slice(0, limit),
        truncated: batches.length >= 200 || mappedItems.length > limit,
    };
};
