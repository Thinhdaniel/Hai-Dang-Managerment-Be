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
        ['Tổng quan', 'Theo chuyền', 'Theo mã hàng', 'Ngoại lệ']
    );
    workbook.worksheets.forEach((sheet) => {
        assert.equal(sheet.pageSetup.paperSize, 9);
        assert.equal(sheet.pageSetup.fitToWidth, 1);
        assert.equal(sheet.views[0]?.showGridLines, false);
    });
    assert.equal(workbook.getWorksheet('Tổng quan')?.getCell(11, 10).numFmt, '#,##0 "đ"');
    assert.equal(workbook.getWorksheet('Theo chuyền')?.getCell(6, 8).numFmt, '0.0%');
});
