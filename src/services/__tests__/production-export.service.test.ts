import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionWorkbook } from '@/services/production-export.service';

const detail = {
    id: 'day-1',
    plantName: 'Cơ sở 1',
    productionDate: '2026-07-18',
    status: 'locked',
    updatedAt: '2026-07-18T11:00:00.000Z',
    timeSlots: [{ key: '08:00', label: '8h', startMinute: 480, endMinute: 540, kind: 'regular', isActive: true }],
    lines: [
        {
            lineId: 'line-1',
            lineCode: 'CM1',
            leaderName: 'Nguyệt',
            sortOrder: 1,
            workerCount: 10,
            totalTarget: 100,
            totalActual: 90,
            achievementPercent: 90,
            totalAmount: 900_000,
            averageIncome: 90_000,
            runs: [
                {
                    id: 'run-1',
                    planAllocationId: 'allocation-1',
                    itemCode: '416',
                    itemName: 'Mã 416',
                    unit: 'SP',
                    unitPriceSnapshot: 10_000,
                    hourlyQuota: 100,
                },
            ],
            entries: [{ runId: 'run-1', slotKey: '08:00', quantity: 90, amount: 900_000 }],
            slotValues: [{ key: '08:00', runId: 'run-1', target: 100, actual: 90, reported: true }],
        },
    ],
    summary: {
        itemCount: 1,
        totalTarget: 100,
        totalActual: 90,
        totalAmount: 900_000,
        averageIncome: 90_000,
    },
};

test('xuất workbook sản lượng kèm kế hoạch và đúng khổ in', async () => {
    const workbook = await buildProductionWorkbook({
        detail,
        monthDetails: [detail],
        lines: [{ code: 'CM1', leaderName: 'Nguyệt', sortOrder: 1, isActive: true }],
        items: [{ code: '416', name: 'Mã 416', unit: 'SP', unitPrice: 10_000, isActive: true }],
        plan: {
            revision: 3,
            allocations: [
                {
                    id: 'allocation-1',
                    lineId: 'line-1',
                    lineCode: 'CM1',
                    itemCode: '416',
                    plannedQuantity: 100,
                    hourlyQuota: 100,
                    startSlotKey: '08:00',
                    endSlotKey: '08:00',
                    priority: 'high',
                    sourceType: 'manual',
                },
            ],
        },
    });

    assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        ['BC NGAY', 'KE HOACH NGAY', 'NHAP LIEU', 'TONG HOP THANG', 'TH MA HANG', 'DANH MUC']
    );
    assert.equal(workbook.getWorksheet('BC NGAY')?.pageSetup.paperSize, 9);
    assert.equal(workbook.getWorksheet('NHAP LIEU')?.pageSetup.fitToWidth, 1);
    assert.equal(workbook.getWorksheet('KE HOACH NGAY')?.getCell('G6').value, 100);
    assert.equal(workbook.getWorksheet('DANH MUC')?.getCell('A5').value, 'Mã chuyền');
    assert.equal(workbook.getWorksheet('DANH MUC')?.getCell('A9').value, 'Mã hàng');
    assert.ok((await workbook.xlsx.writeBuffer()).byteLength > 5_000);
});
