import { previewProductionQcOpeningWorkbook } from '@/services/production-qc-opening-balance.helpers';
import ExcelJS from 'exceljs';
import assert from 'node:assert/strict';
import test from 'node:test';

const lines = [
    { _id: 'line-1', code: 'CM1', name: 'Chuyền 1' },
    { _id: 'line-2', code: 'CM2', name: 'Chuyền 2' },
];
const items = [{ _id: 'item-1', code: 'HD-01', name: 'Áo mẫu', unit: 'SP' }];

const workbookBuffer = async (headers: string[], rows: unknown[][]) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('QC đầu kỳ');
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await workbook.xlsx.writeBuffer());
};

test('đọc đúng QC đầu kỳ đầy đủ và tồn chưa phân bổ', async () => {
    const buffer = await workbookBuffer(
        [
            'Mã chuyền (*)',
            'Mã hàng',
            'Mã đơn hàng',
            'Chế độ dữ liệu',
            'QC đạt đầu kỳ',
            'QC lỗi đầu kỳ',
            'Chưa kiểm đầu kỳ (*)',
        ],
        [
            ['CM1', 'HD-01', 'DH-01', 'Đầy đủ', 800, 20, 180],
            ['CM2', '', '', 'Chỉ biết tồn', 0, 0, 250],
        ]
    );
    const preview = await previewProductionQcOpeningWorkbook(buffer, lines, items);
    assert.equal(preview.summary.totalRows, 2);
    assert.equal(preview.summary.validRows, 2);
    assert.equal(preview.summary.invalidRows, 0);
    assert.equal(preview.summary.pendingQuantity, 430);
    assert.equal(preview.summary.unallocatedPendingQuantity, 250);
    assert.equal(preview.entries[0].mode, 'full');
    assert.equal(preview.entries[1].mode, 'backlog_only');
    assert.equal(preview.entries[1].allocationState, 'unallocated');
});

test('chặn mã lạ, số âm và khóa nghiệp vụ bị trùng', async () => {
    const buffer = await workbookBuffer(
        ['Mã chuyền', 'Mã hàng', 'Chế độ', 'QC đạt đầu kỳ', 'QC lỗi đầu kỳ', 'Chưa kiểm đầu kỳ'],
        [
            ['CM1', 'HD-01', 'Đầy đủ', 500, 10, 490],
            ['CM1', 'HD-01', 'Đầy đủ', 400, 10, 590],
            ['CM9', 'HD-01', 'Đầy đủ', 100, 0, 50],
            ['CM2', '', 'Chỉ biết tồn', 0, 0, -10],
        ]
    );
    const preview = await previewProductionQcOpeningWorkbook(buffer, lines, items);
    assert.equal(preview.summary.validRows, 1);
    assert.equal(preview.summary.invalidRows, 3);
    assert.match(preview.rows[1].errors.join(' '), /Trùng/);
    assert.match(preview.rows[2].errors.join(' '), /Không tìm thấy chuyền/);
    assert.match(preview.rows[3].errors.join(' '), /không hợp lệ/);
});

test('báo lỗi rõ khi file không có cấu trúc QC đầu kỳ', async () => {
    const buffer = await workbookBuffer(['Tên hàng', 'Số lượng'], [['Áo mẫu', 100]]);
    await assert.rejects(
        () => previewProductionQcOpeningWorkbook(buffer, lines, items),
        /Không tìm thấy cột "Mã chuyền" và "Chưa kiểm đầu kỳ"/
    );
});
