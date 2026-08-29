import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { generateBorrowingHandoverXlsx } from '@/utils/generateBorrowingHandoverXlsx';

test('biên bản cho mượn dùng đúng cơ sở và có đủ thông tin đối tác để in ký', async () => {
    const buffer = await generateBorrowingHandoverXlsx({
        batch: {
            code: 'LO-20260829-001',
            direction: 'outbound',
            type: 'external',
            partnerName: 'Công ty May Đối Tác',
            partnerAddress: 'Khu công nghiệp A, Phú Thọ',
            contactName: 'Nguyễn Văn B',
            contactPhone: '0988000000',
            purpose: 'Mượn máy phục vụ đơn hàng tháng 9',
            plant: { name: 'Cơ Sở Phú Sơn' },
            area: 'Kho máy',
            borrowTime: '2026-08-29T08:00:00.000Z',
            expectedReturnTime: '2026-09-29T08:00:00.000Z',
            plannedQuantity: 1,
        },
        items: [
            {
                status: 'active',
                borrowTime: '2026-08-29T08:00:00.000Z',
                issueCondition: 'Hoạt động tốt',
                accessories: ['Chân vịt'],
                asset: {
                    name: 'Máy 1 kim',
                    machineCode: '1K-JUKI-HD-001',
                    model: 'DDL-8700',
                    serial: 'SN001',
                    brand: { name: 'Juki' },
                    plant: { name: 'Cơ Sở Phú Sơn' },
                    area: 'Kho máy',
                },
            },
        ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(buffer) as any);
    const sheet = workbook.getWorksheet('Bien ban');

    assert.ok(String(sheet?.getCell('A2').value).includes('Cơ Sở Phú Sơn'));
    assert.equal(sheet?.getCell('C10').value, 'Khu công nghiệp A, Phú Thọ');
    assert.ok(String(sheet?.getCell('H10').value).includes('0988000000'));
    assert.equal(sheet?.getCell('C11').value, 'Mượn máy phục vụ đơn hàng tháng 9');
    assert.equal(sheet?.getCell('A13').value, 'STT');
    assert.equal(sheet?.pageSetup.orientation, 'landscape');
    assert.equal(sheet?.pageSetup.fitToWidth, 1);
});
