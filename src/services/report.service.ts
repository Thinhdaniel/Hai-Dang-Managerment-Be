import DistributionRecord from '@/models/DistributionRecord';
import Maintenance from '@/models/Maintenance';
import Asset from '@/models/Asset';
import customResponse from '@/utils/response';
import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';

type ReportGroupBy = 'day' | 'month' | 'quarter';

type FacilityCostFilters = {
    plantId?: string;
    startDate?: Date;
    endDate?: Date;
    groupBy: ReportGroupBy;
};

type FacilityCostPlantRow = {
    plantId?: string;
    plantName: string;
    materialDistributionCost: number;
    externalRepairCost: number;
    totalCost: number;
    distributionCount: number;
    externalRepairCount: number;
    externalRepairAssetCount: number;
    repairSharePercent: number;
};

const EXTERNAL_REPAIR_MODE = 'external';
const COMPLETED_STATUS = 'completed';
const DISTRIBUTION_STATUSES = ['distributed', 'confirmed'];

const parseDateStart = (value: unknown) => {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    date.setHours(0, 0, 0, 0);
    return date;
};

const parseDateEnd = (value: unknown) => {
    if (!value) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    date.setHours(23, 59, 59, 999);
    return date;
};

const parseFacilityCostFilters = (query: Request['query']): FacilityCostFilters => ({
    plantId: query.plantId ? String(query.plantId) : undefined,
    startDate: parseDateStart(query.startDate),
    endDate: parseDateEnd(query.endDate),
    groupBy: ['day', 'month', 'quarter'].includes(String(query.groupBy))
        ? (String(query.groupBy) as ReportGroupBy)
        : 'month',
});

const getPeriodLabel = (date: Date, groupBy: ReportGroupBy) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (groupBy === 'day') return `${year}-${month}-${day}`;
    if (groupBy === 'quarter') return `${year}-Q${Math.floor(date.getMonth() / 3) + 1}`;
    return `${year}-${month}`;
};

const isDateInRange = (date: Date, filters: FacilityCostFilters) => {
    if (filters.startDate && date < filters.startDate) return false;
    if (filters.endDate && date > filters.endDate) return false;
    return true;
};

const roundMoney = (value: number) => Number(value.toFixed(2));

const getDistributionDate = (record: any) => new Date(record.distributedAt || record.confirmedAt || record.createdAt);

const getDistributionCost = (record: any) => {
    const itemTotal = (record.items ?? []).reduce(
        (sum: number, item: any) => sum + Number(item.totalWithVat ?? item.totalPrice ?? 0),
        0
    );
    return roundMoney(itemTotal || Number(record.totalWithVat ?? record.totalAmount ?? 0));
};

const getMaintenanceCost = (item: any) => {
    const costItemsTotal = (item.externalRepair?.costItems ?? []).reduce(
        (sum: number, costItem: any) => sum + Number(costItem.amount ?? 0),
        0
    );
    return roundMoney(Number(item.cost ?? item.externalRepair?.actualCost ?? costItemsTotal ?? 0));
};

const getOrCreatePlantRow = (
    rows: Map<string, FacilityCostPlantRow>,
    plantId?: string,
    plantName = 'Chưa xác định'
) => {
    const key = plantId || 'unknown';
    const existing = rows.get(key);

    if (existing) {
        return existing;
    }

    const row: FacilityCostPlantRow = {
        plantId,
        plantName,
        materialDistributionCost: 0,
        externalRepairCost: 0,
        totalCost: 0,
        distributionCount: 0,
        externalRepairCount: 0,
        externalRepairAssetCount: 0,
        repairSharePercent: 0,
    };
    rows.set(key, row);
    return row;
};

const getAssetIdsForPlant = async (plantId?: string) => {
    if (!plantId) {
        return undefined;
    }

    const assets = await Asset.find({
        plantId: new mongoose.Types.ObjectId(plantId),
        isDeleted: { $ne: true },
    })
        .select('_id')
        .lean();

    return assets.map((asset: any) => asset._id);
};

const buildFacilityCostReport = async (filters: FacilityCostFilters) => {
    const distributionMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        status: { $in: DISTRIBUTION_STATUSES },
    };

    if (filters.plantId) {
        distributionMatch.toPlantId = new mongoose.Types.ObjectId(filters.plantId);
    }

    // Báo cáo chi phí bảo trì: lọc theo cơ sở TẠI THỜI ĐIỂM PHÁT SINH (maintenance.plantId)
    // không lọc theo cơ sở hiện tại của máy để tránh bug chi phí lịch sử bị trôi
    const maintenanceMatch: Record<string, any> = {
        isDeleted: { $ne: true },
        repairMode: EXTERNAL_REPAIR_MODE,
        status: COMPLETED_STATUS,
    };

    if (filters.plantId) {
        maintenanceMatch.plantId = new mongoose.Types.ObjectId(filters.plantId);
    }

    if (filters.startDate || filters.endDate) {
        maintenanceMatch.endDate = {};
        if (filters.startDate) maintenanceMatch.endDate.$gte = filters.startDate;
        if (filters.endDate) maintenanceMatch.endDate.$lte = filters.endDate;
    }

    // Đếm pending/in-progress: vẫn dùng assetId theo plant hiện tại (operational view)
    const assetIds = await getAssetIdsForPlant(filters.plantId);

    const [distributions, completedRepairs, pendingApprovalCount, inProgressCount] = await Promise.all([
        DistributionRecord.find(distributionMatch).populate('toPlantId').lean(),
        Maintenance.find(maintenanceMatch).populate({ path: 'assetId' }).populate({ path: 'plantId' }).lean(),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            repairMode: EXTERNAL_REPAIR_MODE,
            approvalStatus: 'pending',
            ...(assetIds ? { assetId: { $in: assetIds } } : {}),
        }),
        Maintenance.countDocuments({
            isDeleted: { $ne: true },
            repairMode: EXTERNAL_REPAIR_MODE,
            status: 'in_progress',
            ...(assetIds ? { assetId: { $in: assetIds } } : {}),
        }),
    ]);

    const plantRows = new Map<string, FacilityCostPlantRow>();
    const assetIdsByPlant = new Map<string, Set<string>>();
    const periodRows = new Map<
        string,
        { period: string; materialDistributionCost: number; externalRepairCost: number; totalCost: number }
    >();

    distributions.forEach((record: any) => {
        const effectiveDate = getDistributionDate(record);
        if (!isDateInRange(effectiveDate, filters)) return;

        const cost = getDistributionCost(record);
        const plantId = record.toPlantId?._id ? String(record.toPlantId._id) : undefined;
        const plantName = record.toPlantId?.name ?? 'Chưa xác định';
        const plantRow = getOrCreatePlantRow(plantRows, plantId, plantName);
        plantRow.materialDistributionCost = roundMoney(plantRow.materialDistributionCost + cost);
        plantRow.distributionCount += 1;

        const period = getPeriodLabel(effectiveDate, filters.groupBy);
        const periodRow = periodRows.get(period) ?? {
            period,
            materialDistributionCost: 0,
            externalRepairCost: 0,
            totalCost: 0,
        };
        periodRow.materialDistributionCost = roundMoney(periodRow.materialDistributionCost + cost);
        periodRows.set(period, periodRow);
    });

    completedRepairs.forEach((item: any) => {
        const cost = getMaintenanceCost(item);
        const asset = item.assetId;

        // Dùng snapshot cơ sở từ maintenance record — đây là nguồn đúng nghiệp vụ
        // Fallback "Chưa xác định" cho bản ghi cũ chưa có snapshot (chạy backfill để khắc phục)
        const maintenancePlantId: string | undefined = item.plantId?._id
            ? String(item.plantId._id)
            : item.plantId
              ? String(item.plantId)
              : undefined;
        const maintenancePlantName: string | undefined = item.plantName || item.plantId?.name;

        const plantId = maintenancePlantId;
        const plantName = maintenancePlantName ?? 'Chưa xác định';
        const plantRow = getOrCreatePlantRow(plantRows, plantId, plantName);
        plantRow.externalRepairCost = roundMoney(plantRow.externalRepairCost + cost);
        plantRow.externalRepairCount += 1;

        const assetSet = assetIdsByPlant.get(plantId || 'unknown') ?? new Set<string>();
        if (asset?._id) {
            assetSet.add(String(asset._id));
        }
        assetIdsByPlant.set(plantId || 'unknown', assetSet);

        const effectiveDate = new Date(item.endDate || item.updatedAt);
        const period = getPeriodLabel(effectiveDate, filters.groupBy);
        const periodRow = periodRows.get(period) ?? {
            period,
            materialDistributionCost: 0,
            externalRepairCost: 0,
            totalCost: 0,
        };
        periodRow.externalRepairCost = roundMoney(periodRow.externalRepairCost + cost);
        periodRows.set(period, periodRow);
    });

    const costByPlant = Array.from(plantRows.entries())
        .map(([key, row]) => {
            const totalCost = roundMoney(row.materialDistributionCost + row.externalRepairCost);
            const repairSharePercent = totalCost ? roundMoney((row.externalRepairCost / totalCost) * 100) : 0;
            return {
                ...row,
                externalRepairAssetCount: assetIdsByPlant.get(key)?.size ?? 0,
                totalCost,
                repairSharePercent,
            };
        })
        .sort((a, b) => b.totalCost - a.totalCost);

    const costByPeriod = Array.from(periodRows.values())
        .map((row) => ({
            ...row,
            totalCost: roundMoney(row.materialDistributionCost + row.externalRepairCost),
        }))
        .sort((a, b) => a.period.localeCompare(b.period));

    const topAssets = completedRepairs
        .reduce(
            (map, item: any) => {
                const asset = item.assetId;
                if (!asset?._id) return map;
                const assetId = String(asset._id);
                const current = map.get(assetId) ?? {
                    assetId,
                    assetName: asset.name,
                    machineCode: asset.machineCode,
                    plantName: item.plantName || item.plantId?.name || asset.plantId?.name,
                    totalCost: 0,
                    count: 0,
                };
                current.totalCost = roundMoney(current.totalCost + getMaintenanceCost(item));
                current.count += 1;
                map.set(assetId, current);
                return map;
            },
            new Map<
                string,
                {
                    assetId: string;
                    assetName: string;
                    machineCode?: string;
                    plantName?: string;
                    totalCost: number;
                    count: number;
                }
            >()
        )
        .values();

    const topExternalRepairAssets = Array.from(topAssets)
        .sort((a, b) => b.totalCost - a.totalCost)
        .slice(0, 10);
    const materialDistributionCost = costByPlant.reduce((sum, row) => sum + row.materialDistributionCost, 0);
    const externalRepairCost = costByPlant.reduce((sum, row) => sum + row.externalRepairCost, 0);
    const externalRepairAssetCount = new Set(
        completedRepairs.map((item: any) => (item.assetId?._id ? String(item.assetId._id) : undefined)).filter(Boolean)
    ).size;

    return {
        summary: {
            materialDistributionCost: roundMoney(materialDistributionCost),
            externalRepairCost: roundMoney(externalRepairCost),
            totalFacilityCost: roundMoney(materialDistributionCost + externalRepairCost),
            distributionRecordCount: distributions.filter((record: any) =>
                isDateInRange(getDistributionDate(record), filters)
            ).length,
            externalRepairCount: completedRepairs.length,
            externalRepairAssetCount,
            pendingApprovalCount,
            inProgressCount,
        },
        costByPlant,
        costByPeriod,
        topExternalRepairAssets,
    };
};

export const getFacilityCostSummary = async (req: Request, res: Response) => {
    const filters = parseFacilityCostFilters(req.query);
    const report = await buildFacilityCostReport(filters);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: report,
            message: 'Lay bao cao chi phi co so thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportFacilityCostSummaryExcel = async (req: Request, res: Response) => {
    const filters = parseFacilityCostFilters(req.query);
    const report = await buildFacilityCostReport(filters);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Hai Dang Ops';
    wb.created = new Date();

    const styleWorksheet = (ws: any) => {
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        ws.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: ws.columnCount || 1 },
        };
        ws.getRow(1).eachCell((cell: any) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
    };

    const wsOverview = wb.addWorksheet('Tong hop');
    wsOverview.columns = [{ width: 36 }, { width: 24 }];
    wsOverview.addRow(['Chi tieu', 'Gia tri']);
    wsOverview.addRow(['Chi phi cap phat vat tu', report.summary.materialDistributionCost]);
    wsOverview.addRow(['Chi phi sua ngoai', report.summary.externalRepairCost]);
    wsOverview.addRow(['Tong chi phi co so', report.summary.totalFacilityCost]);
    wsOverview.addRow(['So phieu cap phat', report.summary.distributionRecordCount]);
    wsOverview.addRow(['So phieu sua ngoai hoan tat', report.summary.externalRepairCount]);
    wsOverview.addRow(['So may sua ngoai', report.summary.externalRepairAssetCount]);
    wsOverview.addRow(['Phieu sua ngoai cho duyet', report.summary.pendingApprovalCount]);
    wsOverview.addRow(['Phieu sua ngoai dang sua', report.summary.inProgressCount]);
    styleWorksheet(wsOverview);

    const wsPlant = wb.addWorksheet('Theo co so');
    wsPlant.columns = [
        { header: 'Co so', key: 'plantName', width: 28 },
        { header: 'Cap phat vat tu', key: 'materialDistributionCost', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Sua ngoai', key: 'externalRepairCost', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Tong chi phi', key: 'totalCost', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Ty trong sua ngoai (%)', key: 'repairSharePercent', width: 18 },
        { header: 'So phieu cap phat', key: 'distributionCount', width: 16 },
        { header: 'So phieu sua ngoai', key: 'externalRepairCount', width: 16 },
        { header: 'So may sua ngoai', key: 'externalRepairAssetCount', width: 16 },
    ];
    report.costByPlant.forEach((row) => wsPlant.addRow(row));
    styleWorksheet(wsPlant);

    const wsPeriod = wb.addWorksheet('Theo ky');
    wsPeriod.columns = [
        { header: 'Ky', key: 'period', width: 16 },
        { header: 'Cap phat vat tu', key: 'materialDistributionCost', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Sua ngoai', key: 'externalRepairCost', width: 18, style: { numFmt: '#,##0' } },
        { header: 'Tong chi phi', key: 'totalCost', width: 18, style: { numFmt: '#,##0' } },
    ];
    report.costByPeriod.forEach((row) => wsPeriod.addRow(row));
    styleWorksheet(wsPeriod);

    const wsAssets = wb.addWorksheet('Top may sua ngoai');
    wsAssets.columns = [
        { header: 'May', key: 'assetName', width: 28 },
        { header: 'Ma may', key: 'machineCode', width: 16 },
        { header: 'Co so', key: 'plantName', width: 24 },
        { header: 'Tong chi phi', key: 'totalCost', width: 18, style: { numFmt: '#,##0' } },
        { header: 'So lan sua', key: 'count', width: 12 },
    ];
    report.topExternalRepairAssets.forEach((row) => wsAssets.addRow(row));
    styleWorksheet(wsAssets);

    const buffer = await wb.xlsx.writeBuffer();
    const startStr = req.query.startDate ? String(req.query.startDate).replace(/-/g, '') : 'all';
    const endStr = req.query.endDate ? String(req.query.endDate).replace(/-/g, '') : 'all';
    const filename = `BaoCaoChiPhiCoSo_${startStr}_${endStr}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
};
