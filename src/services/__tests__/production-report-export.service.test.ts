import { buildProductionReportWorkbook } from '@/services/production-report-export.service';
import assert from 'node:assert/strict';
import test from 'node:test';

const report = {
    meta: {
        plantId: 'plant-1',
        plantName: 'Cơ sở 1',
        from: '2026-07-01',
        to: '2026-07-20',
        scope: 'locked',
        financialsVisible: true,
        generatedAt: '2026-07-20T10:00:00.000Z',
        dataCoverage: {
            status: 'complete',
            openingBalanceAvailable: true,
            cutoffDate: '2026-06-30',
            trackingStartDate: '2026-07-01',
            batchCount: 1,
            periodDetailComplete: true,
            cumulativeAvailable: true,
            amountCoveragePercent: 100,
            unallocatedQuantity: 0,
            unpricedQuantity: 0,
        },
    },
    summary: {
        dayCount: 1,
        statusCounts: { draft: 0, submitted: 0, locked: 1 },
        targetQuantity: 100,
        actualQuantity: 95,
        achievementPercent: 95,
        plannedQuantity: 100,
        planAttainmentPercent: 95,
        reportingRate: 100,
        averageWorkers: 10,
        outputPerWorkerDay: 9.5,
        totalAmount: 950_000,
        carryInQuantity: 500,
        trackedToDateQuantity: 95,
        openingQuantity: 500,
        periodQuantity: 95,
        cumulativeQuantity: 595,
        periodAmount: 950_000,
        cumulativeAmount: 5_950_000,
        unallocatedOpeningQuantity: 0,
    },
    trend: [
        {
            productionDate: '2026-07-20',
            status: 'locked',
            targetQuantity: 100,
            actualQuantity: 95,
            achievementPercent: 95,
            plannedQuantity: 100,
            planAttainmentPercent: 95,
            reportingRate: 100,
            workers: 10,
            totalAmount: 950_000,
            periodQuantity: 95,
            cumulativeQuantity: 595,
            cumulativeAmount: 5_950_000,
        },
    ],
    lines: [
        {
            lineId: 'line-1',
            lineCode: 'C1',
            lineName: 'Chuyền 1',
            leaderName: 'Tổ trưởng A',
            activeDays: 1,
            averageWorkers: 10,
            targetQuantity: 100,
            actualQuantity: 95,
            achievementPercent: 95,
            reportingRate: 100,
            outputPerWorkerDay: 9.5,
            underTargetDays: 0,
            totalAmount: 950_000,
            openingQuantity: 500,
            periodQuantity: 95,
            cumulativeQuantity: 595,
            cumulativeAmount: 5_950_000,
            unallocatedOpeningQuantity: 0,
        },
    ],
    items: [
        {
            itemId: 'item-1',
            itemCode: 'HD-01',
            itemName: 'Áo mẫu',
            unit: 'SP',
            activeDays: 1,
            lineCount: 1,
            targetQuantity: 100,
            actualQuantity: 95,
            achievementPercent: 95,
            plannedQuantity: 100,
            planAttainmentPercent: 95,
            totalAmount: 950_000,
            openingQuantity: 500,
            periodQuantity: 95,
            cumulativeQuantity: 595,
            cumulativeAmount: 5_950_000,
        },
    ],
    orders: [
        {
            orderKey: 'PO-01',
            orderCode: 'PO-01',
            itemCodes: ['HD-01'],
            lineCount: 1,
            itemCount: 1,
            openingQuantity: 500,
            periodQuantity: 95,
            cumulativeQuantity: 595,
            targetQuantity: 100,
            achievementPercent: 95,
            plannedQuantity: 100,
            planAttainmentPercent: 95,
            cumulativeAmount: 5_950_000,
            openingAmountComplete: true,
        },
    ],
    exceptionSummary: { total: 1 },
    exceptions: [
        {
            id: 'exception-1',
            productionDate: '2026-07-20',
            severity: 'warning',
            type: 'under_target',
            lineCode: 'C1',
            title: 'C1 hụt khoán',
            description: 'Chỉ đạt 95% trong ngày.',
        },
    ],
};

test('xuất báo cáo quản trị đủ sheet và cấu hình A4 một trang ngang', async () => {
    const workbook = await buildProductionReportWorkbook(report);

    assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        ['Tổng quan', 'Theo chuyền', 'Theo mã hàng', 'Theo đơn hàng', 'Theo ngày', 'Đối soát đầu kỳ', 'Ngoại lệ']
    );
    workbook.worksheets.forEach((sheet) => {
        assert.equal(sheet.pageSetup.paperSize, 9);
        assert.equal(sheet.pageSetup.fitToWidth, 1);
        assert.equal(sheet.views[0]?.showGridLines, false);
    });
    assert.equal(workbook.getWorksheet('Tổng quan')?.getCell(11, 11).numFmt, '#,##0 "đ"');
    assert.equal(workbook.getWorksheet('Theo chuyền')?.getCell(6, 10).numFmt, '0.0%');
    assert.equal(workbook.getWorksheet('Đối soát đầu kỳ')?.getCell(13, 6).formula, 'C13+D13');
});
