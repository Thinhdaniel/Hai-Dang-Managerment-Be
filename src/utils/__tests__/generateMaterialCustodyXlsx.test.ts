import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMaterialCustodyWorkbook } from '@/utils/generateMaterialCustodyXlsx';

test('material custody workbook contains complete management sheets and printable data', async () => {
    const workbook = buildMaterialCustodyWorkbook({
        plantName: 'Cơ Sở 1 (CS1)',
        generatedAt: new Date('2026-09-04T01:00:00.000Z'),
        summary: { openAssignments: 1, overdueAssignments: 1, activeHolderCount: 1, outstandingValue: 120000 },
        assignments: [
            {
                materialCode: 'VT-001',
                materialName: 'Kéo cắt chỉ',
                holderCode: 'CN001',
                holderName: 'Nguyễn Văn A',
                department: 'Sản xuất',
                lineName: 'CM1',
                itemCode: 'MH-028',
                quantityIssued: 2,
                outstandingQuantity: 1,
                unit: 'Cái',
                issuedAt: '2026-09-01',
                dueAt: '2026-09-03',
                status: 'recall_due',
                overdue: true,
                sourceType: 'new_stock',
            },
        ],
        campaigns: [
            {
                campaignCode: 'DTSD-001',
                itemCode: 'MH-028',
                status: 'recalling',
                holderCount: 1,
                assignmentCount: 1,
                issuedQuantity: 2,
                outstandingQuantity: 1,
            },
        ],
        reusableStock: [
            {
                materialCode: 'VT-001',
                materialName: 'Kéo cắt chỉ',
                unit: 'Cái',
                availableQuantity: 1,
                repairQuantity: 0,
                damagedQuantity: 0,
            },
        ],
    });

    assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        ['Tổng quan', 'Sổ đang giữ', 'Đợt mã hàng', 'Kho tái sử dụng']
    );
    assert.equal(workbook.getWorksheet('Sổ đang giữ')?.getCell('B5').value, 'VT-001');
    assert.equal(workbook.getWorksheet('Sổ đang giữ')?.getCell('O5').value, 'Quá hạn');
    assert.equal(workbook.getWorksheet('Sổ đang giữ')?.pageSetup.fitToWidth, 1);
    const buffer = await workbook.xlsx.writeBuffer();
    assert.ok(buffer.byteLength > 1_000);
});
