import Asset from '@/models/Asset';
import Borrowing from '@/models/Borrowing';
import Plant from '@/models/Plant';
import { ASSET_OWNERSHIP_TYPE } from '@/constant/assetStatus';

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
};
