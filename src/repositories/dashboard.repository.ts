import Asset from '@/models/Asset';
import Borrowing from '@/models/Borrowing';
import Plant from '@/models/Plant';
import Maintenance from '@/models/Maintenance';
import DistributionRecord from '@/models/DistributionRecord';
import { ASSET_OWNERSHIP_TYPE } from '@/constant/assetStatus';
import { AT_PLANT_RADIUS_M, MAX_ACCURACY_M } from '@/constant/mislocation';
import { format, startOfMonth, subDays, subMonths } from 'date-fns';
import { Types } from 'mongoose';

type DashboardSummaryRow = {
    totalMachines: number;
    activeMachines: number;
    maintenanceMachines: number;
    inactiveMachines: number;
    unassignedMachines: number;
};

type FacilityStatsRow = {
    facilityId: string;
    facilityName: string;
    facilityCode: string;
    address?: string;
    machineCount: number;
};

type DashboardActivityRow = {
    id: string;
    category: 'transfer' | 'borrowing';
    action: 'created' | 'approved' | 'completed' | 'rejected' | 'borrowed' | 'returned';
    status: string;
    timestamp: Date;
    asset: {
        id?: string | null;
        name?: string | null;
        machineCode?: string | null;
    };
    facility?: {
        id?: string | null;
        name?: string | null;
    };
    fromFacility?: {
        id?: string | null;
        name?: string | null;
    };
    toFacility?: {
        id?: string | null;
        name?: string | null;
    };
    counterpart?: string | null;
    description?: string | null;
    note?: string | null;
};

type TopBrokenAssetRow = {
    assetId: string;
    assetName?: string;
    machineCode?: string;
    plantName?: string;
    count: number;
    lastDate?: Date;
};

type OverdueTicketRow = {
    id: string;
    assetName?: string;
    machineCode?: string;
    plantName?: string;
    status: string;
    repairMode: string;
    description?: string;
    createdAt: Date;
    daysOpen: number;
};

type CostTrendRow = {
    month: string;
    repairCost: number;
    distributionCost: number;
    totalCost: number;
};

type MislocatedAssetRow = {
    assetId: string;
    assetName?: string;
    machineCode?: string;
    officialPlantName?: string;
    actualPlantName?: string;
    distanceM?: number;
    accuracy?: number;
    scannedAt?: Date;
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const round1 = (value: number) => Number(value.toFixed(1));
const round0 = (value: number) => Math.round(value);

// Trạng thái phiếu bảo trì coi là "đang mở" (chưa kết thúc) — dùng cho tồn đọng.
const OPEN_MAINTENANCE_STATUSES = ['pending', 'in_progress', 'overdue'];

export const dashboardRepository = {
    async getSummaryMetrics() {
        const [summaryRow] = await Asset.aggregate<DashboardSummaryRow>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                },
            },
            {
                $group: {
                    _id: null,
                    totalMachines: { $sum: 1 },
                    activeMachines: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'active'] }, 1, 0],
                        },
                    },
                    maintenanceMachines: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'maintenance'] }, 1, 0],
                        },
                    },
                    inactiveMachines: {
                        $sum: {
                            $cond: [{ $in: ['$status', ['broken', 'storage']] }, 1, 0],
                        },
                    },
                    unassignedMachines: {
                        $sum: {
                            $cond: [{ $ifNull: ['$plantId', false] }, 0, 1],
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    totalMachines: 1,
                    activeMachines: 1,
                    maintenanceMachines: 1,
                    inactiveMachines: 1,
                    unassignedMachines: 1,
                },
            },
        ]);

        const [facilityCountRow] = await Plant.aggregate<{ totalFacilities: number }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                },
            },
            {
                $count: 'totalFacilities',
            },
        ]);

        return {
            totalMachines: summaryRow?.totalMachines ?? 0,
            activeMachines: summaryRow?.activeMachines ?? 0,
            maintenanceMachines: summaryRow?.maintenanceMachines ?? 0,
            inactiveMachines: summaryRow?.inactiveMachines ?? 0,
            totalFacilities: facilityCountRow?.totalFacilities ?? 0,
            unassignedMachines: summaryRow?.unassignedMachines ?? 0,
        };
    },

    getFacilityStats() {
        return Plant.aggregate<FacilityStatsRow>([
            {
                $match: {
                    isDeleted: { $ne: true },
                },
            },
            {
                $lookup: {
                    from: 'assets',
                    let: {
                        facilityId: '$_id',
                    },
                    pipeline: [
                        {
                            $match: {
                                isDeleted: { $ne: true },
                                $or: [
                                    { ownershipType: ASSET_OWNERSHIP_TYPE.OWNED },
                                    { ownershipType: { $exists: false } },
                                ],
                                $expr: {
                                    $eq: ['$plantId', '$$facilityId'],
                                },
                            },
                        },
                        {
                            $count: 'machineCount',
                        },
                    ],
                    as: 'machineStats',
                },
            },
            {
                $addFields: {
                    machineCount: {
                        $ifNull: [{ $arrayElemAt: ['$machineStats.machineCount', 0] }, 0],
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    facilityId: { $toString: '$_id' },
                    facilityName: '$name',
                    facilityCode: '$code',
                    address: '$address',
                    machineCount: 1,
                },
            },
            {
                $sort: {
                    machineCount: -1,
                    facilityName: 1,
                },
            },
        ]);
    },

    getRecentActivities(limit = 10) {
        return Borrowing.aggregate<DashboardActivityRow>([
            {
                $match: {
                    isDeleted: { $ne: true },
                },
            },
            {
                $lookup: {
                    from: 'assets',
                    localField: 'assetId',
                    foreignField: '_id',
                    as: 'asset',
                },
            },
            {
                $unwind: {
                    path: '$asset',
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $lookup: {
                    from: 'plants',
                    localField: 'asset.plantId',
                    foreignField: '_id',
                    as: 'facility',
                },
            },
            {
                $unwind: {
                    path: '$facility',
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    _id: 0,
                    id: { $toString: '$_id' },
                    category: { $literal: 'borrowing' },
                    action: {
                        $cond: [{ $eq: ['$status', 'returned'] }, 'returned', 'borrowed'],
                    },
                    status: '$status',
                    timestamp: { $ifNull: ['$returnTime', '$borrowTime'] },
                    asset: {
                        id: {
                            $cond: [{ $ifNull: ['$asset._id', false] }, { $toString: '$asset._id' }, null],
                        },
                        name: '$asset.name',
                        machineCode: '$asset.machineCode',
                    },
                    facility: {
                        id: {
                            $cond: [{ $ifNull: ['$facility._id', false] }, { $toString: '$facility._id' }, null],
                        },
                        name: '$facility.name',
                    },
                    counterpart: { $ifNull: ['$borrowerName', '$partnerName'] },
                    description: '$purpose',
                    note: { $ifNull: ['$returnNote', '$note'] },
                    sortPriority: { $literal: 2 },
                },
            },
            {
                $unionWith: {
                    coll: 'transfers',
                    pipeline: [
                        {
                            $match: {
                                isDeleted: { $ne: true },
                            },
                        },
                        {
                            $lookup: {
                                from: 'assets',
                                localField: 'assetId',
                                foreignField: '_id',
                                as: 'asset',
                            },
                        },
                        {
                            $unwind: {
                                path: '$asset',
                                preserveNullAndEmptyArrays: true,
                            },
                        },
                        {
                            $lookup: {
                                from: 'plants',
                                localField: 'fromPlantId',
                                foreignField: '_id',
                                as: 'fromFacility',
                            },
                        },
                        {
                            $unwind: {
                                path: '$fromFacility',
                                preserveNullAndEmptyArrays: true,
                            },
                        },
                        {
                            $lookup: {
                                from: 'plants',
                                localField: 'toPlantId',
                                foreignField: '_id',
                                as: 'toFacility',
                            },
                        },
                        {
                            $unwind: {
                                path: '$toFacility',
                                preserveNullAndEmptyArrays: true,
                            },
                        },
                        {
                            $project: {
                                _id: 0,
                                id: { $toString: '$_id' },
                                category: { $literal: 'transfer' },
                                action: {
                                    $switch: {
                                        branches: [
                                            { case: { $eq: ['$status', 'completed'] }, then: 'completed' },
                                            { case: { $eq: ['$status', 'approved'] }, then: 'approved' },
                                            { case: { $eq: ['$status', 'rejected'] }, then: 'rejected' },
                                        ],
                                        default: 'created',
                                    },
                                },
                                status: '$status',
                                timestamp: {
                                    $ifNull: [
                                        '$completedAt',
                                        { $ifNull: ['$approvedAt', { $ifNull: ['$transferDate', '$createdAt'] }] },
                                    ],
                                },
                                asset: {
                                    id: {
                                        $cond: [{ $ifNull: ['$asset._id', false] }, { $toString: '$asset._id' }, null],
                                    },
                                    name: '$asset.name',
                                    machineCode: '$asset.machineCode',
                                },
                                fromFacility: {
                                    id: {
                                        $cond: [
                                            { $ifNull: ['$fromFacility._id', false] },
                                            { $toString: '$fromFacility._id' },
                                            null,
                                        ],
                                    },
                                    name: '$fromFacility.name',
                                },
                                toFacility: {
                                    id: {
                                        $cond: [
                                            { $ifNull: ['$toFacility._id', false] },
                                            { $toString: '$toFacility._id' },
                                            null,
                                        ],
                                    },
                                    name: '$toFacility.name',
                                },
                                description: '$reason',
                                note: '$note',
                                sortPriority: { $literal: 1 },
                            },
                        },
                    ],
                },
            },
            {
                $sort: {
                    timestamp: -1,
                    sortPriority: 1,
                },
            },
            {
                $limit: limit,
            },
            {
                $project: {
                    sortPriority: 0,
                },
            },
        ]);
    },

    // Top máy bị bảo trì/hỏng nhiều nhất theo SỐ LẦN phát sinh phiếu (khác báo cáo chi phí theo tiền).
    getTopBrokenAssets(limit = 8, plantId?: string) {
        return Maintenance.aggregate<TopBrokenAssetRow>([
            { $match: { isDeleted: { $ne: true } } },
            { $group: { _id: '$assetId', count: { $sum: 1 }, lastDate: { $max: '$createdAt' } } },
            { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'asset' } },
            { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
            ...(plantId ? [{ $match: { 'asset.plantId': new Types.ObjectId(plantId) } }] : []),
            { $sort: { count: -1 as const, lastDate: -1 as const } },
            { $limit: limit },
            { $lookup: { from: 'plants', localField: 'asset.plantId', foreignField: '_id', as: 'plant' } },
            { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 0,
                    assetId: { $toString: '$_id' },
                    assetName: '$asset.name',
                    machineCode: '$asset.machineCode',
                    plantName: '$plant.name',
                    count: 1,
                    lastDate: 1,
                },
            },
        ]);
    },

    // Thời gian xử lý trung bình của phiếu đã hoàn thành (createdAt → endDate), theo ngày.
    async getResolutionStats() {
        const monthStart = startOfMonth(new Date());
        const buildAvg = (extraMatch: Record<string, unknown>) =>
            Maintenance.aggregate<{ avgMs: number; count: number }>([
                { $match: { isDeleted: { $ne: true }, status: 'completed', endDate: { $ne: null }, ...extraMatch } },
                { $project: { durationMs: { $subtract: ['$endDate', '$createdAt'] } } },
                { $match: { durationMs: { $gte: 0 } } },
                { $group: { _id: null, avgMs: { $avg: '$durationMs' }, count: { $sum: 1 } } },
            ]);

        const [[overall], [thisMonth]] = await Promise.all([buildAvg({}), buildAvg({ endDate: { $gte: monthStart } })]);

        return {
            avgDaysAll: overall?.avgMs ? round1(overall.avgMs / MS_PER_DAY) : 0,
            completedAll: overall?.count ?? 0,
            avgDaysThisMonth: thisMonth?.avgMs ? round1(thisMonth.avgMs / MS_PER_DAY) : 0,
            completedThisMonth: thisMonth?.count ?? 0,
        };
    },

    // Phiếu bảo trì còn mở quá `days` ngày — cảnh báo tồn đọng.
    async getOverdueTickets(days = 7, limit = 8) {
        const threshold = subDays(new Date(), days);
        const match = {
            isDeleted: { $ne: true },
            status: { $in: OPEN_MAINTENANCE_STATUSES },
            createdAt: { $lt: threshold },
        };

        const [count, items] = await Promise.all([
            Maintenance.countDocuments(match),
            Maintenance.find(match)
                .sort({ createdAt: 1 })
                .limit(limit)
                .populate('assetId', 'name machineCode')
                .populate('plantId', 'name')
                .lean(),
        ]);

        const now = Date.now();
        const rows: OverdueTicketRow[] = items.map((item: any) => ({
            id: String(item._id),
            assetName: item.assetId?.name,
            machineCode: item.assetId?.machineCode,
            plantName: item.plantName || item.plantId?.name,
            status: item.status,
            repairMode: item.repairMode,
            description: item.description,
            createdAt: item.createdAt,
            daysOpen: Math.floor((now - new Date(item.createdAt).getTime()) / MS_PER_DAY),
        }));

        return { count, thresholdDays: days, items: rows };
    },

    // Xu hướng chi phí vận hành theo tháng (sửa ngoài + cấp phát vật tư), `months` tháng gần nhất.
    async getCostTrend(months = 6) {
        const rangeStart = startOfMonth(subMonths(new Date(), months - 1));

        const [repairAgg, distributions] = await Promise.all([
            Maintenance.aggregate<{ key: string; cost: number }>([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        repairMode: 'external',
                        status: 'completed',
                        endDate: { $gte: rangeStart },
                    },
                },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m', date: '$endDate' } },
                        cost: { $sum: { $ifNull: ['$cost', 0] } },
                    },
                },
                { $project: { _id: 0, key: '$_id', cost: 1 } },
            ]),
            DistributionRecord.find({
                isDeleted: { $ne: true },
                status: { $in: ['distributed', 'confirmed'] },
            })
                .select('items totalWithVat totalAmount distributedAt confirmedAt createdAt')
                .lean(),
        ]);

        const repairMap = new Map(repairAgg.map((row) => [row.key, row.cost]));

        // Chi phí cấp phát tính trong JS để khớp đúng nghiệp vụ báo cáo (ưu tiên total theo dòng).
        const distMap = new Map<string, number>();
        distributions.forEach((record: any) => {
            const date = new Date(record.distributedAt || record.confirmedAt || record.createdAt);
            if (date < rangeStart) return;
            const itemTotal = (record.items ?? []).reduce(
                (sum: number, item: any) => sum + Number(item.totalWithVat ?? item.totalPrice ?? 0),
                0
            );
            const cost = itemTotal || Number(record.totalWithVat ?? record.totalAmount ?? 0);
            const key = format(date, 'yyyy-MM');
            distMap.set(key, (distMap.get(key) ?? 0) + cost);
        });

        const trend: CostTrendRow[] = [];
        for (let index = months - 1; index >= 0; index -= 1) {
            const monthDate = startOfMonth(subMonths(new Date(), index));
            const key = format(monthDate, 'yyyy-MM');
            const repairCost = round0(repairMap.get(key) ?? 0);
            const distributionCost = round0(distMap.get(key) ?? 0);
            trend.push({ month: key, repairCost, distributionCost, totalCost: repairCost + distributionCost });
        }

        return trend;
    },

    // Máy lệch vị trí: cơ sở GPS gần nhất (lastSeen) khác cơ sở hệ thống, với lần quét đủ tin cậy.
    getMislocatedAssets(limit = 8) {
        return Asset.aggregate<MislocatedAssetRow>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                    'lastSeen.plantId': { $ne: null },
                    'lastSeen.distanceM': { $lte: AT_PLANT_RADIUS_M },
                    'lastSeen.accuracy': { $lte: MAX_ACCURACY_M },
                    $expr: { $ne: ['$lastSeen.plantId', '$plantId'] },
                },
            },
            { $sort: { 'lastSeen.scannedAt': -1 } },
            { $limit: limit },
            { $lookup: { from: 'plants', localField: 'plantId', foreignField: '_id', as: 'officialPlant' } },
            { $unwind: { path: '$officialPlant', preserveNullAndEmptyArrays: true } },
            { $lookup: { from: 'plants', localField: 'lastSeen.plantId', foreignField: '_id', as: 'actualPlant' } },
            { $unwind: { path: '$actualPlant', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 0,
                    assetId: { $toString: '$_id' },
                    assetName: '$name',
                    machineCode: '$machineCode',
                    officialPlantName: '$officialPlant.name',
                    actualPlantName: '$actualPlant.name',
                    distanceM: '$lastSeen.distanceM',
                    accuracy: '$lastSeen.accuracy',
                    scannedAt: '$lastSeen.scannedAt',
                },
            },
        ]);
    },

    // Máy có toạ độ GPS lần quét cuối (để vẽ lên bản đồ). Populate đủ để serializeAsset suy ra locationMismatch.
    getAssetLocationDocs(plantId?: string) {
        const match: Record<string, unknown> = {
            isDeleted: { $ne: true },
            $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
            'lastSeen.lat': { $type: 'number' },
            'lastSeen.lng': { $type: 'number' },
        };
        if (plantId) match.plantId = plantId;
        return Asset.find(match)
            .select('name machineCode publicId type model brandId area status plantId lastSeen ownershipType')
            .populate('plantId', 'name code coordinates')
            .populate('brandId', 'name')
            .populate('lastSeen.plantId', 'name code')
            .populate('lastSeen.scannedBy', 'name fullname username')
            .lean();
    },

    // Đếm máy chưa có dữ liệu GPS (chưa từng quét hoặc thiết bị không cấp toạ độ) — hiển thị "X máy chưa định vị".
    countAssetsWithoutGps(plantId?: string) {
        const match: Record<string, unknown> = {
            isDeleted: { $ne: true },
            $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
            'lastSeen.lat': { $not: { $type: 'number' } },
        };
        if (plantId) match.plantId = plantId;
        return Asset.countDocuments(match);
    },

    // Cơ sở có toạ độ -> marker nhà máy trên bản đồ.
    getPlantsWithCoordinates() {
        const match: Record<string, unknown> = {
            isDeleted: { $ne: true },
            'coordinates.lat': { $ne: null, $exists: true },
            'coordinates.lng': { $ne: null, $exists: true },
        };
        return Plant.find(match).select('name code coordinates').lean();
    },
};
