import Asset from '@/models/Asset';
import DistributionRecord from '@/models/DistributionRecord';
import InventoryStock from '@/models/InventoryStock';
import Maintenance from '@/models/Maintenance';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import PurchaseShortage from '@/models/PurchaseShortage';
import QrLabel from '@/models/QrLabel';
import StocktakeSession from '@/models/StocktakeSession';
import SupplyShortage from '@/models/SupplyShortage';
import Transfer from '@/models/Transfer';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { QR_LABEL_STATUS } from '@/constant/qrLabel';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { compareValues } from '@/services/executive-briefing.helpers';
import type {
    BriefingAssetReference,
    BriefingEvidence,
    BriefingLowStockItem,
    BriefingPeriodRange,
    BriefingPlantPerformance,
    ExecutiveBriefingSnapshot,
} from '@/types/executiveBriefing';

const OPEN_MAINTENANCE_STATUSES = ['pending', 'in_progress', 'overdue'];
const OPEN_SHORTAGE_STATUSES = ['outstanding', 'partially_settled'];
const PURCHASE_ORDER_VALUE_STATUSES = ['ordered', 'partially_received', 'received'];
const OPERATIONAL_ASSET_STATUSES = [
    ASSET_STATUS.ACTIVE,
    ASSET_STATUS.MAINTENANCE,
    ASSET_STATUS.BROKEN,
    ASSET_STATUS.STORAGE,
    ASSET_STATUS.PENDING_DISPOSAL,
];
const OWNED_ASSET_MATCH = {
    isDeleted: { $ne: true },
    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
};

const n = (value: unknown) => Number(value || 0);
const round1 = (value: number) => Number(value.toFixed(1));
const roundCurrency = (value: number) => Math.round(value);
const formatCount = (value: number) => Math.round(value).toLocaleString('vi-VN');
const formatCurrency = (value: number) => `${Math.round(value).toLocaleString('vi-VN')} đ`;
const formatPercent = (value: number) => `${round1(value).toLocaleString('vi-VN')}%`;
const formatDays = (value: number) => `${round1(value).toLocaleString('vi-VN')} ngày`;

const amountExpression = (prefix: string) => ({
    $cond: [
        { $gt: [`$${prefix}.totalWithVat`, 0] },
        `$${prefix}.totalWithVat`,
        {
            $cond: [
                { $gt: [`$${prefix}.totalPrice`, 0] },
                `$${prefix}.totalPrice`,
                {
                    $multiply: [
                        { $ifNull: [`$${prefix}.quantityOrdered`, { $ifNull: [`$${prefix}.quantity`, 0] }] },
                        { $ifNull: [`$${prefix}.unitPrice`, 0] },
                    ],
                },
            ],
        },
    ],
});

const getFleetSnapshot = async () => {
    const [row] = await Asset.aggregate<any>([
        { $match: OWNED_ASSET_MATCH },
        {
            $group: {
                _id: null,
                registeredOwned: { $sum: 1 },
                operationalMachines: {
                    $sum: { $cond: [{ $in: ['$status', OPERATIONAL_ASSET_STATUSES] }, 1, 0] },
                },
                activeMachines: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.ACTIVE] }, 1, 0] } },
                maintenanceMachines: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.MAINTENANCE] }, 1, 0] },
                },
                brokenMachines: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.BROKEN] }, 1, 0] } },
                storageMachines: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.STORAGE] }, 1, 0] } },
                pendingDisposalMachines: {
                    $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.PENDING_DISPOSAL] }, 1, 0] },
                },
                disposedMachines: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.DISPOSED] }, 1, 0] } },
                unassignedMachines: { $sum: { $cond: [{ $ifNull: ['$plantId', false] }, 0, 1] } },
            },
        },
    ]);

    const [qrRow] = await QrLabel.aggregate<{ count: number }>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: QR_LABEL_STATUS.ASSIGNED,
                assetId: { $ne: null },
            },
        },
        { $group: { _id: '$assetId' } },
        { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'asset' } },
        { $unwind: '$asset' },
        {
            $match: {
                'asset.isDeleted': { $ne: true },
                'asset.status': { $in: OPERATIONAL_ASSET_STATUSES },
                $or: [
                    { 'asset.ownershipType': ASSET_OWNERSHIP_TYPE.OWNED },
                    { 'asset.ownershipType': { $exists: false } },
                ],
            },
        },
        { $count: 'count' },
    ]);

    const operationalMachines = n(row?.operationalMachines);
    const activeMachines = n(row?.activeMachines);
    const linkedQrAssets = n(qrRow?.count);
    return {
        registeredOwned: n(row?.registeredOwned),
        operationalMachines,
        activeMachines,
        maintenanceMachines: n(row?.maintenanceMachines),
        brokenMachines: n(row?.brokenMachines),
        storageMachines: n(row?.storageMachines),
        pendingDisposalMachines: n(row?.pendingDisposalMachines),
        disposedMachines: n(row?.disposedMachines),
        unassignedMachines: n(row?.unassignedMachines),
        linkedQrAssets,
        availabilityPct: operationalMachines ? round1((activeMachines / operationalMachines) * 100) : 0,
        qrCoveragePct: operationalMachines ? round1((linkedQrAssets / operationalMachines) * 100) : 0,
    };
};

const getMaintenancePeriodStats = async (start: Date, end: Date) => {
    const [newTickets, emergencyTickets, completionRows, externalCostRows] = await Promise.all([
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            createdAt: { $gte: start, $lte: end },
        }),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            type: 'emergency',
            status: { $ne: 'cancelled' },
            createdAt: { $gte: start, $lte: end },
        }),
        Maintenance.aggregate<any>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    status: 'completed',
                    endDate: { $gte: start, $lte: end },
                },
            },
            {
                $project: {
                    durationMs: { $subtract: ['$endDate', { $ifNull: ['$startDate', '$createdAt'] }] },
                    hasEvidence: {
                        $and: [
                            { $gt: [{ $size: { $ifNull: ['$beforeImages', []] } }, 0] },
                            { $gt: [{ $size: { $ifNull: ['$afterImages', []] } }, 0] },
                        ],
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    completedTickets: { $sum: 1 },
                    avgDurationMs: {
                        $avg: { $cond: [{ $gte: ['$durationMs', 0] }, '$durationMs', null] },
                    },
                    completedWithEvidence: { $sum: { $cond: ['$hasEvidence', 1, 0] } },
                },
            },
        ]),
        Maintenance.aggregate<{ total: number }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    status: 'completed',
                    repairMode: 'external',
                    endDate: { $gte: start, $lte: end },
                },
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: { $ifNull: ['$externalRepair.actualCost', { $ifNull: ['$cost', 0] }] } },
                },
            },
        ]),
    ]);

    const completedTickets = n(completionRows[0]?.completedTickets);
    return {
        newTickets,
        emergencyTickets,
        completedTickets,
        avgResolutionDays: completionRows[0]?.avgDurationMs
            ? round1(n(completionRows[0].avgDurationMs) / 86_400_000)
            : 0,
        completedWithEvidence: n(completionRows[0]?.completedWithEvidence),
        evidenceCoveragePct: completedTickets
            ? round1((n(completionRows[0]?.completedWithEvidence) / completedTickets) * 100)
            : 0,
        externalRepairCost: roundCurrency(n(externalCostRows[0]?.total)),
    };
};

const getRepeatMaintenanceAssets = async (start: Date, end: Date): Promise<BriefingAssetReference[]> => {
    const rows = await Maintenance.aggregate<any>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: { $ne: 'cancelled' },
                createdAt: { $gte: start, $lte: end },
            },
        },
        {
            $project: {
                assets: {
                    $setUnion: [{ $ifNull: ['$assetIds', []] }, [{ $ifNull: ['$assetId', null] }]],
                },
            },
        },
        { $unwind: '$assets' },
        { $match: { assets: { $ne: null } } },
        { $group: { _id: '$assets', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
        { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'asset' } },
        { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'plants', localField: 'asset.plantId', foreignField: '_id', as: 'plant' } },
        { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
    ]);
    return rows.map((row) => ({
        id: String(row._id),
        machineCode: row.asset?.machineCode,
        name: row.asset?.name,
        plantName: row.plant?.name,
        count: n(row.count),
    }));
};

const getNotableIncidents = async (start: Date, end: Date): Promise<BriefingAssetReference[]> => {
    const docs = await Maintenance.find({
        isDeleted: { $ne: true },
        type: 'emergency',
        status: { $ne: 'cancelled' },
        createdAt: { $gte: start, $lte: end },
    })
        .sort({ status: 1, createdAt: -1 })
        .limit(5)
        .populate('assetId', 'machineCode name')
        .populate('plantId', 'name')
        .lean();

    return docs.map((doc: any) => ({
        id: String(doc._id),
        machineCode: doc.assetId?.machineCode,
        name: doc.assetId?.name,
        plantName: doc.plantName || doc.plantId?.name,
        status: doc.status,
        description: doc.description,
        occurredAt: doc.createdAt,
    }));
};

const getMaintenanceSnapshot = async (period: BriefingPeriodRange) => {
    const [current, previous, openTickets, overdue, topRepeatAssets, notableIncidents] = await Promise.all([
        getMaintenancePeriodStats(period.rangeStart, period.rangeEnd),
        getMaintenancePeriodStats(period.comparisonStart, period.comparisonEnd),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            status: { $in: OPEN_MAINTENANCE_STATUSES },
        }),
        dashboardRepository.getOverdueTickets(7, 5),
        getRepeatMaintenanceAssets(period.rangeStart, period.rangeEnd),
        getNotableIncidents(period.rangeStart, period.rangeEnd),
    ]);

    return {
        newTickets: compareValues(current.newTickets, previous.newTickets),
        completedTickets: compareValues(current.completedTickets, previous.completedTickets),
        emergencyTickets: compareValues(current.emergencyTickets, previous.emergencyTickets),
        externalRepairCost: compareValues(current.externalRepairCost, previous.externalRepairCost),
        openTickets,
        overdueTickets: overdue.count,
        avgResolutionDays: current.avgResolutionDays,
        repeatFailureAssets: topRepeatAssets.length,
        completedWithEvidence: current.completedWithEvidence,
        evidenceCoveragePct: current.evidenceCoveragePct,
        topRepeatAssets,
        notableIncidents,
    };
};

const getPurchaseValue = async (start: Date, end: Date) => {
    const [row] = await PurchaseOrder.aggregate<{ total: number; fallbackDates: number }>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: { $in: PURCHASE_ORDER_VALUE_STATUSES },
            },
        },
        {
            $set: {
                effectiveDate: { $ifNull: ['$orderedAt', '$createdAt'] },
                usedFallbackDate: { $eq: [{ $ifNull: ['$orderedAt', null] }, null] },
            },
        },
        { $match: { effectiveDate: { $gte: start, $lte: end } } },
        { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
        {
            $group: {
                _id: '$_id',
                amount: { $sum: amountExpression('items') },
                orderAmount: { $first: { $ifNull: ['$totalWithVat', { $ifNull: ['$totalAmount', 0] }] } },
                usedFallbackDate: { $first: '$usedFallbackDate' },
            },
        },
        {
            $group: {
                _id: null,
                total: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', '$orderAmount'] } },
                fallbackDates: { $sum: { $cond: ['$usedFallbackDate', 1, 0] } },
            },
        },
    ]);
    return { total: roundCurrency(n(row?.total)), fallbackDates: n(row?.fallbackDates) };
};

const distributionAmountProjection = {
    itemAmount: {
        $sum: {
            $map: {
                input: { $ifNull: ['$items', []] },
                as: 'item',
                in: {
                    $cond: [
                        { $gt: ['$$item.totalWithVat', 0] },
                        '$$item.totalWithVat',
                        {
                            $cond: [
                                { $gt: ['$$item.totalPrice', 0] },
                                '$$item.totalPrice',
                                {
                                    $multiply: [
                                        {
                                            $ifNull: [
                                                '$$item.quantityDistributed',
                                                { $ifNull: ['$$item.quantity', 0] },
                                            ],
                                        },
                                        { $ifNull: ['$$item.unitPrice', 0] },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            },
        },
    },
    recordAmount: { $ifNull: ['$totalWithVat', { $ifNull: ['$totalAmount', 0] }] },
};

const getDistributionValue = async (start: Date, end: Date) => {
    const [row] = await DistributionRecord.aggregate<{ total: number }>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: { $in: ['distributed', 'confirmed'] },
            },
        },
        { $set: { effectiveDate: { $ifNull: ['$distributedAt', { $ifNull: ['$confirmedAt', '$createdAt'] }] } } },
        { $match: { effectiveDate: { $gte: start, $lte: end } } },
        { $project: distributionAmountProjection },
        { $project: { amount: { $cond: [{ $gt: ['$itemAmount', 0] }, '$itemAmount', '$recordAmount'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return roundCurrency(n(row?.total));
};

const getLowStock = async () => {
    const rows = await InventoryStock.aggregate<any>([
        { $match: { isDeleted: { $ne: true } } },
        { $lookup: { from: 'materials', localField: 'materialId', foreignField: '_id', as: 'material' } },
        { $unwind: '$material' },
        { $lookup: { from: 'plants', localField: 'plantId', foreignField: '_id', as: 'plant' } },
        { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
        {
            $match: {
                'material.isDeleted': { $ne: true },
                'material.isActive': { $ne: false },
                'material.trackInventory': { $ne: false },
                'material.minStockLevel': { $gt: 0 },
                $expr: { $lte: ['$currentStock', '$material.minStockLevel'] },
            },
        },
        {
            $project: {
                _id: 0,
                materialId: { $toString: '$material._id' },
                materialCode: '$material.code',
                materialName: '$material.name',
                unit: '$material.unit',
                plantId: { $toString: '$plantId' },
                plantName: { $ifNull: ['$plant.name', 'Chưa gán cơ sở'] },
                currentStock: { $ifNull: ['$currentStock', 0] },
                minStockLevel: '$material.minStockLevel',
                shortage: { $max: [{ $subtract: ['$material.minStockLevel', '$currentStock'] }, 0] },
            },
        },
        { $sort: { shortage: -1, currentStock: 1, materialName: 1 } },
        { $limit: 2000 },
    ]);
    return rows as BriefingLowStockItem[];
};

const getOpenShortageStats = async (model: typeof PurchaseShortage | typeof SupplyShortage, quantityField: string) => {
    const [row] = await model.aggregate<any>([
        { $match: { isDeleted: { $ne: true }, status: { $in: OPEN_SHORTAGE_STATUSES } } },
        {
            $group: {
                _id: null,
                count: { $sum: 1 },
                quantity: {
                    $sum: {
                        $max: [
                            {
                                $subtract: [
                                    { $ifNull: [`$${quantityField}`, 0] },
                                    { $ifNull: ['$quantityResolved', 0] },
                                ],
                            },
                            0,
                        ],
                    },
                },
            },
        },
    ]);
    return { count: n(row?.count), quantity: round1(n(row?.quantity)) };
};

const getMaterialsSnapshot = async (period: BriefingPeriodRange, lowStock: BriefingLowStockItem[]) => {
    const [
        purchaseCurrent,
        purchasePrevious,
        distributionCurrent,
        distributionPrevious,
        pending,
        approved,
        partial,
        purchaseShortages,
        supplyShortages,
        configuredMinimums,
    ] = await Promise.all([
        getPurchaseValue(period.rangeStart, period.rangeEnd),
        getPurchaseValue(period.comparisonStart, period.comparisonEnd),
        getDistributionValue(period.rangeStart, period.rangeEnd),
        getDistributionValue(period.comparisonStart, period.comparisonEnd),
        PurchaseRequest.countDocuments({
            isDeleted: { $ne: true },
            requestType: { $in: ['purchase', 'technical_purchase'] },
            status: 'pending',
        }),
        PurchaseRequest.countDocuments({
            isDeleted: { $ne: true },
            requestType: { $in: ['purchase', 'technical_purchase'] },
            status: 'approved',
        }),
        PurchaseOrder.countDocuments({
            isDeleted: { $ne: true },
            status: 'partially_received',
        }),
        getOpenShortageStats(PurchaseShortage, 'quantityMissing'),
        getOpenShortageStats(SupplyShortage, 'quantityShortage'),
        Material.countDocuments({
            isDeleted: { $ne: true },
            isActive: { $ne: false },
            trackInventory: { $ne: false },
            minStockLevel: { $gt: 0 },
        }),
    ]);

    return {
        snapshot: {
            purchaseValue: compareValues(purchaseCurrent.total, purchasePrevious.total),
            distributionValue: compareValues(distributionCurrent, distributionPrevious),
            pendingPurchaseRequests: pending,
            approvedAwaitingOrder: approved,
            partialPurchaseOrders: partial,
            openPurchaseShortages: purchaseShortages.count,
            openPurchaseShortageQuantity: purchaseShortages.quantity,
            openSupplyShortages: supplyShortages.count,
            openSupplyShortageQuantity: supplyShortages.quantity,
            lowStockCount: lowStock.length,
            lowStockItems: lowStock.slice(0, 12),
        },
        purchaseFallbackDates: purchaseCurrent.fallbackDates,
        configuredMinimums,
    };
};

const getTransferPeriodStats = async (start: Date, end: Date) => {
    const [created, completedRow] = await Promise.all([
        Transfer.countDocuments({
            isDeleted: { $ne: true },
            createdAt: { $gte: start, $lte: end },
        }),
        Transfer.aggregate<any>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    status: 'completed',
                    completedAt: { $gte: start, $lte: end },
                },
            },
            {
                $project: {
                    assetCount: {
                        $cond: [{ $gt: [{ $size: { $ifNull: ['$assetIds', []] } }, 0] }, { $size: '$assetIds' }, 1],
                    },
                },
            },
            { $group: { _id: null, completed: { $sum: 1 }, assets: { $sum: '$assetCount' } } },
        ]),
    ]);
    return { created, completed: n(completedRow[0]?.completed), assets: n(completedRow[0]?.assets) };
};

const getStocktakePeriodStats = async (start: Date, end: Date) => {
    const [row] = await StocktakeSession.aggregate<any>([
        { $match: { finishedAt: { $gte: start, $lte: end } } },
        {
            $group: {
                _id: null,
                sessions: { $sum: 1 },
                missing: { $sum: { $ifNull: ['$missingCount', 0] } },
                anomalies: { $sum: { $ifNull: ['$anomalyCount', 0] } },
            },
        },
    ]);
    return { sessions: n(row?.sessions), missing: n(row?.missing), anomalies: n(row?.anomalies) };
};

const getOperationsSnapshot = async (period: BriefingPeriodRange) => {
    const [currentTransfers, previousTransfers, openTransfers, mislocated, currentStocktake, previousStocktake] =
        await Promise.all([
            getTransferPeriodStats(period.rangeStart, period.rangeEnd),
            getTransferPeriodStats(period.comparisonStart, period.comparisonEnd),
            Transfer.countDocuments({
                isDeleted: { $ne: true },
                status: { $in: ['pending', 'approved'] },
            }),
            dashboardRepository.getMislocatedAssets(2000),
            getStocktakePeriodStats(period.rangeStart, period.rangeEnd),
            getStocktakePeriodStats(period.comparisonStart, period.comparisonEnd),
        ]);

    return {
        transfersCreated: compareValues(currentTransfers.created, previousTransfers.created),
        transfersCompleted: compareValues(currentTransfers.completed, previousTransfers.completed),
        transferredAssets: currentTransfers.assets,
        openTransfers,
        mislocatedAssets: mislocated.length,
        mislocatedItems: mislocated.slice(0, 8).map((row) => ({
            id: row.assetId,
            machineCode: row.machineCode,
            name: row.assetName,
            plantName: `${row.officialPlantName || 'Chưa rõ'} → ${row.actualPlantName || 'Chưa rõ'}`,
            occurredAt: row.scannedAt,
        })),
        stocktakeSessions: compareValues(currentStocktake.sessions, previousStocktake.sessions),
        stocktakeMissing: currentStocktake.missing,
        stocktakeAnomalies: currentStocktake.anomalies,
    };
};

const getPurchaseValueByPlant = async (start: Date, end: Date) => {
    const rows = await PurchaseOrder.aggregate<any>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: { $in: PURCHASE_ORDER_VALUE_STATUSES },
            },
        },
        { $set: { effectiveDate: { $ifNull: ['$orderedAt', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: start, $lte: end } } },
        { $unwind: '$items' },
        { $set: { effectivePlantId: { $ifNull: ['$items.plantId', '$plantId'] } } },
        { $group: { _id: '$effectivePlantId', total: { $sum: amountExpression('items') } } },
    ]);
    return new Map(rows.filter((row) => row._id).map((row) => [String(row._id), roundCurrency(n(row.total))]));
};

const getDistributionValueByPlant = async (start: Date, end: Date) => {
    const rows = await DistributionRecord.aggregate<any>([
        {
            $match: {
                isDeleted: { $ne: true },
                status: { $in: ['distributed', 'confirmed'] },
            },
        },
        { $set: { effectiveDate: { $ifNull: ['$distributedAt', { $ifNull: ['$confirmedAt', '$createdAt'] }] } } },
        { $match: { effectiveDate: { $gte: start, $lte: end } } },
        { $project: { toPlantId: 1, ...distributionAmountProjection } },
        {
            $project: {
                toPlantId: 1,
                amount: { $cond: [{ $gt: ['$itemAmount', 0] }, '$itemAmount', '$recordAmount'] },
            },
        },
        { $group: { _id: '$toPlantId', total: { $sum: '$amount' } } },
    ]);
    return new Map(rows.filter((row) => row._id).map((row) => [String(row._id), roundCurrency(n(row.total))]));
};

const getPlantPerformance = async (
    period: BriefingPeriodRange,
    lowStock: BriefingLowStockItem[]
): Promise<BriefingPlantPerformance[]> => {
    const overdueThreshold = new Date(Date.now() - 7 * 86_400_000);
    const [plants, assetRows, maintenanceRows, stocktakeRows, purchaseMap, distributionMap] = await Promise.all([
        Plant.find({ isDeleted: { $ne: true } })
            .select('_id name code')
            .lean(),
        Asset.aggregate<any>([
            { $match: OWNED_ASSET_MATCH },
            {
                $group: {
                    _id: '$plantId',
                    operational: { $sum: { $cond: [{ $in: ['$status', OPERATIONAL_ASSET_STATUSES] }, 1, 0] } },
                    active: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.ACTIVE] }, 1, 0] } },
                    maintenance: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.MAINTENANCE] }, 1, 0] } },
                    broken: { $sum: { $cond: [{ $eq: ['$status', ASSET_STATUS.BROKEN] }, 1, 0] } },
                },
            },
        ]),
        Maintenance.aggregate<any>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [
                        { createdAt: { $gte: period.rangeStart, $lte: period.rangeEnd } },
                        { endDate: { $gte: period.rangeStart, $lte: period.rangeEnd } },
                        { status: { $in: OPEN_MAINTENANCE_STATUSES } },
                    ],
                },
            },
            {
                $group: {
                    _id: '$plantId',
                    newTickets: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $gte: ['$createdAt', period.rangeStart] },
                                        { $lte: ['$createdAt', period.rangeEnd] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                    completedTickets: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$status', 'completed'] },
                                        { $gte: ['$endDate', period.rangeStart] },
                                        { $lte: ['$endDate', period.rangeEnd] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                    overdueTickets: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $in: ['$status', OPEN_MAINTENANCE_STATUSES] },
                                        { $lt: ['$createdAt', overdueThreshold] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
        ]),
        StocktakeSession.aggregate<any>([
            { $match: { finishedAt: { $gte: period.rangeStart, $lte: period.rangeEnd } } },
            { $group: { _id: '$plantId', anomalies: { $sum: { $ifNull: ['$anomalyCount', 0] } } } },
        ]),
        getPurchaseValueByPlant(period.rangeStart, period.rangeEnd),
        getDistributionValueByPlant(period.rangeStart, period.rangeEnd),
    ]);

    const assets = new Map(assetRows.filter((row) => row._id).map((row) => [String(row._id), row]));
    const maintenance = new Map(maintenanceRows.filter((row) => row._id).map((row) => [String(row._id), row]));
    const stocktakes = new Map(stocktakeRows.filter((row) => row._id).map((row) => [String(row._id), row]));
    const lowStockByPlant = new Map<string, number>();
    lowStock.forEach((row) => {
        if (!row.plantId) return;
        lowStockByPlant.set(row.plantId, (lowStockByPlant.get(row.plantId) || 0) + 1);
    });

    return plants
        .map((plant: any) => {
            const key = String(plant._id);
            const asset = assets.get(key) || {};
            const maintenanceRow = maintenance.get(key) || {};
            const operationalMachines = n(asset.operational);
            const activeMachines = n(asset.active);
            const availabilityPct = operationalMachines ? round1((activeMachines / operationalMachines) * 100) : 0;
            const overdueTickets = n(maintenanceRow.overdueTickets);
            const lowStockCount = lowStockByPlant.get(key) || 0;
            const stocktakeAnomalies = n(stocktakes.get(key)?.anomalies);
            const attentionLevel: BriefingPlantPerformance['attentionLevel'] =
                overdueTickets > 0 || availabilityPct < 80 || stocktakeAnomalies > 0
                    ? 'critical'
                    : availabilityPct < 90 || lowStockCount > 0
                      ? 'watch'
                      : 'stable';
            return {
                plantId: key,
                plantName: plant.name,
                plantCode: plant.code,
                operationalMachines,
                activeMachines,
                maintenanceMachines: n(asset.maintenance),
                brokenMachines: n(asset.broken),
                availabilityPct,
                newTickets: n(maintenanceRow.newTickets),
                completedTickets: n(maintenanceRow.completedTickets),
                overdueTickets,
                lowStockCount,
                purchaseValue: purchaseMap.get(key) || 0,
                distributionValue: distributionMap.get(key) || 0,
                stocktakeAnomalies,
                attentionLevel,
            };
        })
        .sort((a, b) => {
            const rank = { critical: 0, watch: 1, stable: 2 };
            return rank[a.attentionLevel] - rank[b.attentionLevel] || a.availabilityPct - b.availabilityPct;
        });
};

const toneForCount = (value: number, criticalAt: number) =>
    value <= 0 ? ('positive' as const) : value >= criticalAt ? ('critical' as const) : ('warning' as const);

const buildEvidence = (
    fleet: ExecutiveBriefingSnapshot['fleet'],
    maintenance: ExecutiveBriefingSnapshot['maintenance'],
    materials: ExecutiveBriefingSnapshot['materials'],
    operations: ExecutiveBriefingSnapshot['operations']
): BriefingEvidence[] => [
    {
        key: 'fleet.availabilityPct',
        label: 'Máy sẵn sàng',
        value: fleet.availabilityPct,
        formattedValue: formatPercent(fleet.availabilityPct),
        unit: 'percent',
        tone: fleet.availabilityPct >= 90 ? 'positive' : fleet.availabilityPct >= 80 ? 'warning' : 'critical',
    },
    {
        key: 'fleet.qrCoveragePct',
        label: 'Máy đã liên kết tem QR',
        value: fleet.qrCoveragePct,
        formattedValue: formatPercent(fleet.qrCoveragePct),
        unit: 'percent',
        tone: fleet.qrCoveragePct >= 95 ? 'positive' : fleet.qrCoveragePct >= 80 ? 'warning' : 'critical',
    },
    {
        key: 'maintenance.newTickets',
        label: 'Phiếu bảo trì mới',
        value: maintenance.newTickets.current,
        formattedValue: formatCount(maintenance.newTickets.current),
        previous: maintenance.newTickets.previous,
        formattedPrevious: formatCount(maintenance.newTickets.previous),
        deltaPct: maintenance.newTickets.deltaPct,
        unit: 'count',
        tone: maintenance.newTickets.delta > 0 ? 'warning' : 'neutral',
    },
    {
        key: 'maintenance.completedTickets',
        label: 'Phiếu bảo trì hoàn tất',
        value: maintenance.completedTickets.current,
        formattedValue: formatCount(maintenance.completedTickets.current),
        previous: maintenance.completedTickets.previous,
        formattedPrevious: formatCount(maintenance.completedTickets.previous),
        deltaPct: maintenance.completedTickets.deltaPct,
        unit: 'count',
        tone: maintenance.completedTickets.current > 0 ? 'positive' : 'neutral',
    },
    {
        key: 'maintenance.overdueTickets',
        label: 'Phiếu mở trên 7 ngày',
        value: maintenance.overdueTickets,
        formattedValue: formatCount(maintenance.overdueTickets),
        unit: 'count',
        tone: toneForCount(maintenance.overdueTickets, 5),
    },
    {
        key: 'maintenance.avgResolutionDays',
        label: 'Thời gian xử lý trung bình',
        value: maintenance.avgResolutionDays,
        formattedValue: formatDays(maintenance.avgResolutionDays),
        unit: 'days',
        tone: maintenance.avgResolutionDays > 7 ? 'warning' : 'neutral',
    },
    {
        key: 'maintenance.externalRepairCost',
        label: 'Chi phí sửa ngoài',
        value: maintenance.externalRepairCost.current,
        formattedValue: formatCurrency(maintenance.externalRepairCost.current),
        previous: maintenance.externalRepairCost.previous,
        formattedPrevious: formatCurrency(maintenance.externalRepairCost.previous),
        deltaPct: maintenance.externalRepairCost.deltaPct,
        unit: 'currency',
        tone:
            maintenance.externalRepairCost.deltaPct !== null && maintenance.externalRepairCost.deltaPct > 25
                ? 'warning'
                : 'neutral',
    },
    {
        key: 'materials.purchaseValue',
        label: 'Giá trị đơn mua',
        value: materials.purchaseValue.current,
        formattedValue: formatCurrency(materials.purchaseValue.current),
        previous: materials.purchaseValue.previous,
        formattedPrevious: formatCurrency(materials.purchaseValue.previous),
        deltaPct: materials.purchaseValue.deltaPct,
        unit: 'currency',
        tone: 'neutral',
    },
    {
        key: 'materials.distributionValue',
        label: 'Giá trị đã cấp phát',
        value: materials.distributionValue.current,
        formattedValue: formatCurrency(materials.distributionValue.current),
        previous: materials.distributionValue.previous,
        formattedPrevious: formatCurrency(materials.distributionValue.previous),
        deltaPct: materials.distributionValue.deltaPct,
        unit: 'currency',
        tone: 'neutral',
    },
    {
        key: 'materials.lowStockCount',
        label: 'Vật tư dưới định mức',
        value: materials.lowStockCount,
        formattedValue: formatCount(materials.lowStockCount),
        unit: 'count',
        tone: toneForCount(materials.lowStockCount, 10),
    },
    {
        key: 'materials.openPurchaseShortages',
        label: 'Dòng mua còn thiếu',
        value: materials.openPurchaseShortages,
        formattedValue: formatCount(materials.openPurchaseShortages),
        unit: 'count',
        tone: toneForCount(materials.openPurchaseShortages, 5),
    },
    {
        key: 'operations.transfersCompleted',
        label: 'Lệnh điều chuyển hoàn tất',
        value: operations.transfersCompleted.current,
        formattedValue: formatCount(operations.transfersCompleted.current),
        previous: operations.transfersCompleted.previous,
        formattedPrevious: formatCount(operations.transfersCompleted.previous),
        deltaPct: operations.transfersCompleted.deltaPct,
        unit: 'count',
        tone: operations.transfersCompleted.current > 0 ? 'positive' : 'neutral',
    },
    {
        key: 'operations.mislocatedAssets',
        label: 'Máy có dấu hiệu sai vị trí',
        value: operations.mislocatedAssets,
        formattedValue: formatCount(operations.mislocatedAssets),
        unit: 'count',
        tone: toneForCount(operations.mislocatedAssets, 5),
    },
    {
        key: 'operations.stocktakeAnomalies',
        label: 'Bất thường kiểm kê',
        value: operations.stocktakeAnomalies + operations.stocktakeMissing,
        formattedValue: formatCount(operations.stocktakeAnomalies + operations.stocktakeMissing),
        unit: 'count',
        tone: toneForCount(operations.stocktakeAnomalies + operations.stocktakeMissing, 5),
    },
];

export const buildExecutiveBriefingSnapshot = async (
    period: BriefingPeriodRange
): Promise<ExecutiveBriefingSnapshot> => {
    const lowStock = await getLowStock();
    const [fleet, maintenance, materialResult, operations, plants, unknownMaintenancePlantCount] = await Promise.all([
        getFleetSnapshot(),
        getMaintenanceSnapshot(period),
        getMaterialsSnapshot(period, lowStock),
        getOperationsSnapshot(period),
        getPlantPerformance(period, lowStock),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            createdAt: { $gte: period.rangeStart, $lte: period.rangeEnd },
            plantId: { $exists: false },
        }),
    ]);

    const dataWarnings: string[] = [];
    if (materialResult.purchaseFallbackDates > 0) {
        dataWarnings.push(
            `${materialResult.purchaseFallbackDates} đơn mua trong kỳ thiếu ngày đặt hàng; hệ thống đã dùng ngày tạo đơn để xác định kỳ.`
        );
    }
    if (materialResult.configuredMinimums === 0) {
        dataWarnings.push(
            'Chưa có vật tư nào được cấu hình định mức tồn tối thiểu; cảnh báo tồn thấp chưa có ý nghĩa đầy đủ.'
        );
    }
    if (maintenance.completedTickets.current > 0 && maintenance.evidenceCoveragePct < 50) {
        dataWarnings.push(
            `Chỉ ${formatPercent(maintenance.evidenceCoveragePct)} phiếu bảo trì hoàn tất có đủ ảnh trước và sau sửa.`
        );
    }
    if (unknownMaintenancePlantCount > 0) {
        dataWarnings.push(`${unknownMaintenancePlantCount} phiếu bảo trì trong kỳ chưa có snapshot cơ sở.`);
    }
    if (lowStock.length >= 2000) {
        dataWarnings.push(
            'Danh sách vật tư dưới định mức đã đạt giới hạn 2.000 dòng; cần kiểm tra lại dữ liệu tồn kho.'
        );
    }

    const snapshot: ExecutiveBriefingSnapshot = {
        fleet,
        maintenance,
        materials: materialResult.snapshot,
        operations,
        plants,
        evidence: [],
        dataDefinitions: [
            {
                key: 'fleet.availabilityPct',
                label: 'Tỷ lệ máy sẵn sàng',
                definition:
                    'Máy hoạt động chia cho máy thuộc phạm vi vận hành; không gồm máy đã thanh lý hoặc đã trả đối tác.',
            },
            {
                key: 'maintenance.externalRepairCost',
                label: 'Chi phí sửa ngoài',
                definition: 'Chi phí thực tế của phiếu sửa ngoài đã hoàn tất trong kỳ, theo ngày hoàn tất.',
            },
            {
                key: 'materials.purchaseValue',
                label: 'Giá trị đơn mua',
                definition:
                    'Giá trị các dòng đơn mua đã đặt trong kỳ, theo ngày đặt hàng; chưa đồng nghĩa với chi phí đã cấp phát.',
            },
            {
                key: 'materials.distributionValue',
                label: 'Giá trị cấp phát',
                definition: 'Giá trị vật tư đã xuất hoặc xác nhận cấp phát trong kỳ, theo cơ sở nhận.',
            },
            {
                key: 'materials.lowStockCount',
                label: 'Vật tư dưới định mức',
                definition: 'Snapshot tồn hiện tại của vật tư có định mức lớn hơn 0 và tồn không vượt định mức.',
            },
            {
                key: 'fleet.qrCoveragePct',
                label: 'Độ phủ QR',
                definition:
                    'Tỷ lệ máy trong phạm vi vận hành có tem QR trạng thái đang liên kết; không xác nhận tem còn dán vật lý.',
            },
        ],
        dataWarnings,
    };
    snapshot.evidence = buildEvidence(fleet, maintenance, snapshot.materials, operations);
    return snapshot;
};
