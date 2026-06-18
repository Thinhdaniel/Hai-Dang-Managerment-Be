import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import { ASSET_OWNERSHIP_TYPE } from '@/constant/assetStatus';
import { ROLE_GROUPS } from '@/constant/permissions';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { serializeAsset, serializePlant } from '@/utils/serializers';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { format, startOfMonth, startOfWeek, subWeeks } from 'date-fns';

const toIso = (value?: Date | string | null) => {
    if (!value) return undefined;
    return new Date(value).toISOString();
};

export const getDashboardOverview = async (req: Request, res: Response, next: NextFunction) => {
    const monthStart = startOfMonth(new Date());
    const [summary, facilityStatsRaw, recentActivitiesRaw, externalRepairAgg, externalRepairPendingApproval, externalRepairInProgress] = await Promise.all([
        dashboardRepository.getSummaryMetrics(),
        dashboardRepository.getFacilityStats(),
        dashboardRepository.getRecentActivities(10),
        Maintenance.aggregate<{ totalCost: number; count: number }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    repairMode: 'external',
                    status: 'completed',
                    endDate: { $gte: monthStart },
                },
            },
            {
                $group: {
                    _id: null,
                    totalCost: { $sum: { $ifNull: ['$cost', 0] } },
                    count: { $sum: 1 },
                },
            },
            { $project: { _id: 0, totalCost: 1, count: 1 } },
        ]),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            repairMode: 'external',
            approvalStatus: 'pending',
        }),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            repairMode: 'external',
            status: 'in_progress',
        }),
    ]);
    const externalRepairMonth = externalRepairAgg[0] ?? { totalCost: 0, count: 0 };
    // Chi phí (số tiền) chỉ cho ADMIN + Giám đốc — ẩn con số với role khác (FE cũng ẩn thẻ).
    const canViewCost = (ROLE_GROUPS.DIRECTOR_UP as readonly string[]).includes(String(req.role));

    const facilityStats = facilityStatsRaw.map((item) => ({
        ...item,
        sharePercent:
            summary.totalMachines > 0 ? Number(((item.machineCount / summary.totalMachines) * 100).toFixed(1)) : 0,
    }));

    const recentActivities = recentActivitiesRaw.map((item) => ({
        ...item,
        timestamp: toIso(item.timestamp) ?? new Date().toISOString(),
    }));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                summary,
                maintenanceCost: {
                    externalRepairCostThisMonth: canViewCost ? externalRepairMonth.totalCost : 0,
                    externalRepairCompletedThisMonth: externalRepairMonth.count,
                    externalRepairPendingApproval,
                    externalRepairInProgress,
                },
                facilityStats,
                recentActivities,
            },
            message: 'Lay tong quan dashboard thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getDashboardInsights = async (req: Request, res: Response, next: NextFunction) => {
    // Chi phí chỉ dành cho ADMIN + Giám đốc — không trả costTrend cho role khác (chặn rò rỉ qua API).
    const canViewCost = (ROLE_GROUPS.DIRECTOR_UP as readonly string[]).includes(String(req.role));

    const [topBrokenAssets, resolution, overdue, costTrend, mislocatedAssets] = await Promise.all([
        dashboardRepository.getTopBrokenAssets(8),
        dashboardRepository.getResolutionStats(),
        dashboardRepository.getOverdueTickets(7, 8),
        canViewCost ? dashboardRepository.getCostTrend(6) : Promise.resolve([]),
        dashboardRepository.getMislocatedAssets(8),
    ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                topBrokenAssets: topBrokenAssets.map((item) => ({ ...item, lastDate: toIso(item.lastDate) })),
                resolution,
                overdue: {
                    ...overdue,
                    items: overdue.items.map((item) => ({ ...item, createdAt: toIso(item.createdAt) })),
                },
                costTrend,
                mislocatedAssets: mislocatedAssets.map((item) => ({ ...item, scannedAt: toIso(item.scannedAt) })),
            },
            message: 'Lay du lieu phan tich dashboard thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// Vị trí GPS lần quét cuối của các máy + cơ sở -> dữ liệu cho mini-map. Chỉ Giám đốc trở lên (chặn ở route bằng authorize).
export const getAssetLocations = async (req: Request, res: Response, next: NextFunction) => {
    const plantId = typeof req.query.plantId === 'string' && req.query.plantId ? req.query.plantId : undefined;

    const [docs, plants, withoutGps] = await Promise.all([
        dashboardRepository.getAssetLocationDocs(plantId),
        dashboardRepository.getPlantsWithCoordinates(),
        dashboardRepository.countAssetsWithoutGps(plantId),
    ]);

    const assets = docs
        .map(serializeAsset)
        .map((asset) => ({
            id: asset.id,
            machineCode: asset.machineCode,
            name: asset.name,
            status: asset.status,
            plantId: asset.plant?.id,
            plantName: asset.plant?.name,
            lat: asset.lastSeen?.lat,
            lng: asset.lastSeen?.lng,
            accuracy: asset.lastSeen?.accuracy,
            distanceM: asset.lastSeen?.distanceM,
            scannedAt: asset.lastSeen?.scannedAt,
            scannedByName: asset.lastSeen?.scannedByName,
            mismatch: Boolean(asset.locationMismatch?.mismatch),
            officialPlantName: asset.locationMismatch?.officialPlantName ?? asset.plant?.name,
            actualPlantName: asset.locationMismatch?.actualPlantName ?? asset.lastSeen?.plantName,
        }))
        .filter((asset) => typeof asset.lat === 'number' && typeof asset.lng === 'number');

    const facilities = plants
        .map(serializePlant)
        .filter((plant) => plant.coordinates)
        .map((plant) => ({
            id: plant.id,
            name: plant.name,
            code: plant.code,
            lat: plant.coordinates!.lat,
            lng: plant.coordinates!.lng,
        }));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { assets, facilities, withoutGps },
            message: 'Lay vi tri may tren ban do thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getDashboardStats = async (req: Request, res: Response, next: NextFunction) => {
    const baseFilter = {
        isDeleted: { $ne: true },
        $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
    };
    const [totalAssets, activeAssets, maintenanceAssets, brokenAssets, borrowingAssets, storageAssets] =
        await Promise.all([
            Asset.countDocuments(baseFilter),
            Asset.countDocuments({ ...baseFilter, status: 'active' }),
            Asset.countDocuments({ ...baseFilter, status: 'maintenance' }),
            Asset.countDocuments({ ...baseFilter, status: 'broken' }),
            Asset.countDocuments({ ...baseFilter, status: 'borrowing' }),
            Asset.countDocuments({ ...baseFilter, status: 'storage' }),
        ]);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                totalAssets,
                activeAssets,
                maintenanceAssets,
                brokenAssets,
                borrowingAssets,
                storageAssets,
            },
            message: 'Lay thong ke dashboard thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getDashboardCharts = async (req: Request, res: Response, next: NextFunction) => {
    const [statusDistributionRaw, maintenanceItems] = await Promise.all([
        Asset.aggregate([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                },
            },
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $project: { _id: 0, status: '$_id', count: 1 } },
        ]),
        Maintenance.find({
            isDeleted: { $ne: true },
            createdAt: { $gte: subWeeks(new Date(), 7) },
        }).select('createdAt'),
    ]);

    const maintenanceByWeekMap = new Map<string, number>();
    for (let index = 7; index >= 0; index -= 1) {
        const weekKey = format(startOfWeek(subWeeks(new Date(), index)), 'yyyy-MM-dd');
        maintenanceByWeekMap.set(weekKey, 0);
    }

    maintenanceItems.forEach((item) => {
        const weekKey = format(startOfWeek(new Date(item.createdAt)), 'yyyy-MM-dd');
        maintenanceByWeekMap.set(weekKey, (maintenanceByWeekMap.get(weekKey) ?? 0) + 1);
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                statusDistribution: statusDistributionRaw,
                maintenanceByWeek: Array.from(maintenanceByWeekMap.entries()).map(([date, count]) => ({
                    date,
                    count,
                })),
            },
            message: 'Lay du lieu bieu do thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
