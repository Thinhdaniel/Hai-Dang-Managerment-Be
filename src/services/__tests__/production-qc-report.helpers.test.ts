import { buildProductionQcReport } from '@/services/production-qc-report.helpers';
import { buildProductionQcReportWorkbook } from '@/services/production-qc-report-export.service';
import assert from 'node:assert/strict';
import test from 'node:test';

const baseOptions = () => ({
    plantId: 'plant-1',
    plantName: 'Cơ sở 1',
    from: '2026-08-01',
    to: '2026-08-02',
    trackingStartDate: '2026-08-01',
    productionOpening: {
        coverage: { available: true, cutoffDate: '2026-07-31' },
        entries: [
            {
                lineId: 'line-1',
                lineCode: 'CM1',
                itemId: 'item-1',
                itemCode: 'HD-01',
                itemName: 'Áo mẫu',
                quantity: 1500,
            },
        ],
    },
    qcOpening: {
        coverage: {
            available: true,
            cutoffDate: '2026-07-31',
            historicalQualityComplete: true,
            exactCoveragePercent: 100,
            unallocatedPendingQuantity: 0,
        },
        entries: [
            {
                lineId: 'line-1',
                lineCode: 'CM1',
                itemId: 'item-1',
                itemCode: 'HD-01',
                itemName: 'Áo mẫu',
                mode: 'full',
                passedQuantity: 450,
                defectQuantity: 50,
                pendingQuantity: 1000,
            },
        ],
    },
    lineRecords: [
        {
            dayId: 'day-1',
            plantId: 'plant-1',
            productionDate: '2026-08-01',
            lineId: 'line-1',
            lineCode: 'CM1',
            runs: [
                {
                    _id: 'run-1',
                    itemId: 'item-1',
                    itemCode: 'HD-01',
                    itemName: 'Áo mẫu',
                },
            ],
            entries: [{ slotKey: '08:00', runId: 'run-1', quantity: 600 }],
            qcEntries: [],
        },
    ],
    qcRecords: [
        {
            dayId: 'day-1',
            plantId: 'plant-1',
            productionDate: '2026-08-01',
            lineId: 'line-1',
            lineCode: 'CM1',
            slotKey: '08:00',
            inspections: [
                {
                    itemId: 'item-1',
                    itemCode: 'HD-01',
                    itemName: 'Áo mẫu',
                    inspectionType: 'first_pass',
                    passedQuantity: 1150,
                    defectQuantity: 50,
                },
                {
                    itemId: 'item-1',
                    itemCode: 'HD-01',
                    itemName: 'Áo mẫu',
                    inspectionType: 'recheck',
                    passedQuantity: 30,
                    defectQuantity: 0,
                },
            ],
        },
    ],
});

test('đối soát backlog lũy kế và không trừ tái kiểm lần thứ hai', () => {
    const report = buildProductionQcReport(baseOptions());
    assert.equal(report.summary.periodProduced, 600);
    assert.equal(report.summary.periodFirstPass, 1200);
    assert.equal(report.summary.periodRecheck, 30);
    assert.equal(report.summary.pendingQuantity, 400);
    assert.equal(report.summary.periodDefectRate, 4.17);
    assert.equal(report.summary.periodFirstPassYield, 95.83);
    assert.equal(report.items[0].pendingQuantity, 400);
});

test('record QC có cấu trúc thay thế dữ liệu legacy cùng ô giờ', () => {
    const options: any = baseOptions();
    options.lineRecords[0].qcEntries = [
        { slotKey: '08:00', passedQuantity: 9999, defectQuantity: 0 },
        { slotKey: '09:00', passedQuantity: 20, defectQuantity: 2 },
    ];
    const report = buildProductionQcReport(options);
    assert.equal(report.summary.periodFirstPass, 1222);
    assert.equal(report.meta.coverage.legacyUnallocatedQuantity, 22);
    assert.equal(report.meta.coverage.status, 'partial');
    assert.equal(report.summary.pendingKnown, true);
    assert.equal(report.items.find((row: any) => row.itemId === 'item-1')?.pendingQuantity, undefined);
    assert.equal(report.lines[0].pendingQuantity, 378);
});

test('không hiển thị tồn chờ giả khi lọc mã hàng còn QC cũ chưa phân bổ', () => {
    const options: any = baseOptions();
    options.filters = { itemId: 'item-1' };
    options.lineRecords[0].qcEntries = [{ slotKey: '09:00', passedQuantity: 20, defectQuantity: 2 }];
    const report = buildProductionQcReport(options);
    assert.equal(report.summary.pendingKnown, false);
    assert.equal(report.summary.pendingQuantity, undefined);
    assert.equal(report.summary.pendingUnknownReason, 'unallocated_scope');
    assert.equal(report.exceptions[0].type, 'scope_unallocated');
});

test('không có đầu kỳ QC thì không giả số chưa kiểm bằng 0', () => {
    const options: any = baseOptions();
    options.qcOpening = {
        coverage: { available: false, historicalQualityComplete: false },
        entries: [],
    };
    const report = buildProductionQcReport(options);
    assert.equal(report.summary.pendingKnown, false);
    assert.equal(report.summary.pendingQuantity, undefined);
    assert.equal(report.meta.coverage.status, 'missing');
    assert.equal(report.exceptions[0].type, 'missing_opening');
});

test('xuất báo cáo QC đủ góc nhìn và cấu hình in A4', async () => {
    const report = buildProductionQcReport(baseOptions());
    const workbook = await buildProductionQcReportWorkbook(report);
    assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        ['Tổng quan', 'Theo mã hàng', 'Theo chuyền', 'Theo ngày', 'Bất thường']
    );
    const itemSheet = workbook.getWorksheet('Theo mã hàng');
    const lineSheet = workbook.getWorksheet('Theo chuyền');
    assert.equal(itemSheet?.getCell('A5').value, 'HD-01');
    assert.equal(lineSheet?.getCell('A5').value, 'CM1');
    assert.equal(itemSheet?.pageSetup.paperSize, 9);
    assert.equal(itemSheet?.pageSetup.orientation, 'landscape');
    assert.equal(itemSheet?.pageSetup.fitToWidth, 1);
    assert.equal(itemSheet?.pageSetup.printTitlesRow, '1:4');
});
