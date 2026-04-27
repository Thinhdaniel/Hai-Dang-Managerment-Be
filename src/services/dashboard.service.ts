import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { format, startOfWeek, subWeeks } from 'date-fns';

const toIso = (value?: Date | string | null) => {
    if (!value) return undefined;
    return new Date(value).toISOString();
};

export const getDashboardOverview = async (req: Request, res: Response, next: NextFunction) => {
    const [summary, facilityStatsRaw, recentActivitiesRaw] = await Promise.all([
        dashboardRepository.getSummaryMetrics(),
        dashboardRepository.getFacilityStats(),
        dashboardRepository.getRecentActivities(10),
    ]);

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
                facilityStats,
                recentActivities,
            },
            message: 'Lay tong quan dashboard thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getDashboardStats = async (req: Request, res: Response, next: NextFunction) => {
    const baseFilter = { isDeleted: { $ne: true } };
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
            { $match: { isDeleted: { $ne: true } } },
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
