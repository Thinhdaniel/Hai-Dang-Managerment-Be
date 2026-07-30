import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
    buildProductionOpeningBalanceEntryKey,
    previewProductionOpeningBalanceWorkbook,
} from '../production-opening-balance.helpers';

const lines = [
    { _id: '66a000000000000000000001', code: 'CM5+6', name: 'Chuyền CM5+6' },
    { _id: '66a000000000000000000002', code: 'CM7', name: 'Chuyền CM7' },
];

const items = [
    {
        _id: '66b000000000000000000001',
        code: 'HD-2026',
        name: 'Áo sơ mi Hải Đăng',
        unit: 'SP',
    },
];

const workbookBuffer = async (rows: unknown[][]) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Lũy kế');
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await workbook.xlsx.writeBuffer());
};

test('đọc đúng file đầu kỳ có tiêu đề tiếng Việt và giữ riêng phần chưa phân bổ', async () => {
    const buffer = await workbookBuffer([
        ['BÁO CÁO SẢN LƯỢNG TRƯỚC KHI DÙNG HỆ THỐNG'],
        [],
        ['Mã chuyền', 'Mã hàng', 'Mã đơn hàng', 'Sản lượng đầu kỳ', 'ĐVT', 'Đơn giá lịch sử'],
        ['CM5+6', 'HD-2026', 'PO-01', '12.500', 'SP', '850'],
        ['CM7', '', '', 3200, 'SP', ''],
    ]);

    const preview = await previewProductionOpeningBalanceWorkbook(buffer, lines, items);

    assert.equal(preview.headerRow, 3);
    assert.equal(preview.summary.totalRows, 2);
    assert.equal(preview.summary.validRows, 2);
    assert.equal(preview.summary.invalidRows, 0);
    assert.equal(preview.summary.totalQuantity, 15_700);
    assert.equal(preview.summary.exactQuantity, 12_500);
    assert.equal(preview.summary.unallocatedQuantity, 3_200);
    assert.equal(preview.summary.totalAmount, 10_625_000);
    assert.equal(preview.entries[0]?.allocationState, 'exact');
    assert.equal(preview.entries[1]?.allocationState, 'unallocated');
    assert.equal(
        preview.entries[0]?.entryKey,
        buildProductionOpeningBalanceEntryKey(lines[0], items[0], 'po-01')
    );
});

test('không cho xác nhận file có mã lạ, số âm hoặc trùng khóa nghiệp vụ', async () => {
    const buffer = await workbookBuffer([
        ['Chuyền', 'Mã sản phẩm', 'Đơn hàng', 'Lũy kế trước'],
        ['CM5+6', 'HD-2026', 'PO-01', 100],
        ['CM5+6', 'HD-2026', 'po-01', 50],
        ['CM-KHONG-CO', '', '', 20],
        ['CM7', '', '', -1],
    ]);

    const preview = await previewProductionOpeningBalanceWorkbook(buffer, lines, items);

    assert.equal(preview.summary.totalRows, 4);
    assert.equal(preview.summary.validRows, 1);
    assert.equal(preview.summary.invalidRows, 3);
    assert.match(preview.rows[1]?.errors.join(' '), /Trùng chuyền/);
    assert.match(preview.rows[2]?.errors.join(' '), /Không tìm thấy chuyền/);
    assert.match(preview.rows[3]?.errors.join(' '), /lớn hơn 0/);
});

test('báo lỗi rõ ràng khi file không có cấu trúc đầu kỳ', async () => {
    const buffer = await workbookBuffer([
        ['Tên chuyền', 'Ghi chú'],
        ['CM5+6', 'Không có cột sản lượng'],
    ]);

    await assert.rejects(
        previewProductionOpeningBalanceWorkbook(buffer, lines, items),
        /Không tìm thấy cột "Mã chuyền" và "Sản lượng đầu kỳ"/
    );
});
