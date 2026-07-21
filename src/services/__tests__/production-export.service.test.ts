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

test('xuất workbook báo cáo ngày khớp mẫu công ty và đúng khổ in', async () => {
    const workbook = await buildProductionWorkbook({ detail });

    assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        ['BC NGAY', 'NHAP LIEU']
    );
    const bc = workbook.getWorksheet('BC NGAY');
    assert.equal(bc?.pageSetup.paperSize, 9);
    // Letterhead + tiêu đề đúng vị trí mẫu
    assert.ok(String(bc?.getCell('A1').value).includes('MAY XUẤT KHẨU HẢI ĐĂNG'));
    assert.equal(bc?.getCell('A4').value, 'BÁO CÁO SẢN LƯỢNG NGÀY');
    assert.equal(bc?.getCell('B6').value, '18/07/2026');
    // Header bảng chuyền
    assert.equal(bc?.getCell('A8').value, 'Chuyền');
    assert.equal(bc?.getCell('H8').value, 'TN BQ (đ/người)');
    // Dòng dữ liệu + TỔNG
    assert.equal(bc?.getCell('A9').value, 'CM1');
    assert.equal(bc?.getCell('E9').value, 90);
    assert.equal(bc?.getCell('A10').value, 'TỔNG');
    assert.equal(bc?.getCell('E10').value, 90);
    // Khối theo khung giờ + chữ ký phải có mặt
    const flat = (bc?.getSheetValues() as any[])
        .flat()
        .filter((v) => typeof v === 'string');
    assert.ok(flat.includes('SẢN LƯỢNG THỰC TẾ TOÀN XƯỞNG THEO KHUNG GIỜ'));
    assert.ok(flat.includes('NGƯỜI LẬP BIỂU'));
    assert.ok(flat.includes('GIÁM ĐỐC CƠ SỞ'));

    assert.equal(workbook.getWorksheet('NHAP LIEU')?.pageSetup.fitToWidth, 1);
    assert.ok((await workbook.xlsx.writeBuffer()).byteLength > 5_000);
});
