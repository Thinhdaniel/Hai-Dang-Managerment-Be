import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const thin = { style: 'thin' as const };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
const tnr = (size = 11, bold = false, italic = false) => ({
    name: 'Times New Roman' as const, size, bold, italic,
});

export async function generateSupplyRequestXlsx(sr: any): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Phiếu đề xuất cấp VT', {
        pageSetup: {
            paperSize: 9,
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
    });

    ws.columns = [
        { width: 6 },  // A STT
        { width: 32 }, // B Tên vật tư
        { width: 14 }, // C Mã VT
        { width: 10 }, // D ĐVT
        { width: 14 }, // E SL đề xuất
        { width: 22 }, // F Ghi chú
    ];

    const LAST = 'F';
    const COLS = 6;

    // ROW 1: Company
    ws.mergeCells(`A1:${LAST}1`);
    const r1 = ws.getCell('A1');
    r1.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    r1.font = tnr(12, true);
    r1.alignment = { horizontal: 'left', vertical: 'middle' };

    // ROW 2: Address
    ws.mergeCells(`A2:${LAST}2`);
    const r2 = ws.getCell('A2');
    r2.value = 'Địa chỉ: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
    r2.font = tnr(11, false, true);
    r2.alignment = { horizontal: 'left', vertical: 'middle' };

    // ROW 3: blank
    ws.getRow(3).height = 6;

    // ROW 4: Title
    ws.mergeCells(`A4:${LAST}4`);
    const r4 = ws.getCell('A4');
    r4.value = 'PHIẾU ĐỀ XUẤT CẤP VẬT TƯ';
    r4.font = tnr(18, true);
    r4.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(4).height = 30;

    // ROW 5: Date
    ws.mergeCells(`A5:${LAST}5`);
    const r5 = ws.getCell('A5');
    const d = dayjs(sr.requestDate ?? sr.createdAt);
    r5.value = `Ngày ${d.format('DD')} tháng ${d.format('MM')} năm ${d.format('YYYY')}`;
    r5.font = tnr(11, false, true);
    r5.alignment = { horizontal: 'center', vertical: 'middle' };

    // ROW 6: Code
    ws.mergeCells(`A6:${LAST}6`);
    const r6 = ws.getCell('A6');
    r6.value = `Số: ${sr.requestCode || ''}`;
    r6.font = tnr(11);
    r6.alignment = { horizontal: 'center', vertical: 'middle' };

    // ROW 7: blank
    ws.getRow(7).height = 6;

    // ROW 8-11: Info
    const setLabel = (cell: string, value: string) => {
        const c = ws.getCell(cell);
        c.value = value;
        c.font = tnr(11);
        c.alignment = { horizontal: 'left', vertical: 'middle' };
    };
    const setValue = (cell: string, value: string, mergeEnd?: string) => {
        if (mergeEnd) ws.mergeCells(`${cell}:${mergeEnd}`);
        const c = ws.getCell(cell);
        c.value = value;
        c.font = tnr(11, true);
        c.alignment = { horizontal: 'left', vertical: 'middle' };
    };

    setLabel('A8', 'Cơ sở gửi:');
    setValue('B8', sr.fromPlant?.name || sr.plant?.name || '', `${LAST}8`);

    setLabel('A9', 'Gửi đến:');
    setValue('B9', sr.toPlant?.name || 'Cơ sở chính (CS1)', `${LAST}9`);

    setLabel('A10', 'Người đề xuất:');
    setValue('B10', typeof sr.requestedBy === 'object'
        ? (sr.requestedBy?.name ?? sr.requestedBy?.email ?? '')
        : '', `${LAST}10`);

    setLabel('A11', 'Lý do / Mục đích:');
    setValue('B11', sr.note || '', `${LAST}11`);

    // ROW 13: Table header
    const headers = ['STT', 'Tên vật tư, quy cách', 'Mã VT', 'ĐVT', 'SL đề xuất', 'Ghi chú'];
    const headerRow = ws.getRow(13);
    headerRow.height = 25;
    headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = tnr(11, true);
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = allBorders;
    });

    // DATA ROWS
    let curRow = 14;
    let totalQty = 0;

    (sr.items ?? []).forEach((item: any, idx: number) => {
        const row = ws.getRow(curRow);
        const qty = item.quantityRequested ?? 0;
        totalQty += qty;

        const vals = [
            idx + 1,
            item.materialName ?? item.material?.name ?? '',
            item.material?.code ?? '',
            item.unit ?? item.material?.unit ?? '',
            qty,
            item.note ?? '',
        ];

        vals.forEach((v, c) => {
            const cell = row.getCell(c + 1);
            cell.value = v;
            cell.font = tnr(11);
            cell.border = allBorders;
            if ([0, 3, 4].includes(c)) {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                if (c === 4) cell.numFmt = '#,##0.##';
            } else {
                cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            }
        });
        curRow++;
    });

    // TOTAL ROW
    ws.mergeCells(`A${curRow}:D${curRow}`);
    const totalLabel = ws.getCell(`A${curRow}`);
    totalLabel.value = 'Tổng cộng:';
    totalLabel.font = tnr(11, true);
    totalLabel.alignment = { horizontal: 'center', vertical: 'middle' };

    const totalVal = ws.getCell(`E${curRow}`);
    totalVal.value = totalQty;
    totalVal.font = tnr(11, true);
    totalVal.numFmt = '#,##0.##';
    totalVal.alignment = { horizontal: 'center', vertical: 'middle' };

    for (let c = 1; c <= COLS; c++) ws.getCell(curRow, c).border = allBorders;

    curRow += 2;

    // SIGNATURE
    ws.mergeCells(`A${curRow}:B${curRow}`);
    ws.getCell(`A${curRow}`).value = 'Người lập phiếu';
    ws.getCell(`A${curRow}`).font = tnr(11, true);
    ws.getCell(`A${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`C${curRow}:D${curRow}`);
    ws.getCell(`C${curRow}`).value = 'Người phê duyệt';
    ws.getCell(`C${curRow}`).font = tnr(11, true);
    ws.getCell(`C${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`E${curRow}:${LAST}${curRow}`);
    ws.getCell(`E${curRow}`).value = 'Kế toán / Thủ kho';
    ws.getCell(`E${curRow}`).font = tnr(11, true);
    ws.getCell(`E${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    curRow++;
    ws.getRow(curRow).height = 60;

    curRow++;
    ws.mergeCells(`A${curRow}:B${curRow}`);
    ws.getCell(`A${curRow}`).value = '(Ký, họ tên)';
    ws.getCell(`A${curRow}`).font = tnr(11, false, true);
    ws.getCell(`A${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`C${curRow}:D${curRow}`);
    ws.getCell(`C${curRow}`).value = '(Ký, họ tên)';
    ws.getCell(`C${curRow}`).font = tnr(11, false, true);
    ws.getCell(`C${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`E${curRow}:${LAST}${curRow}`);
    ws.getCell(`E${curRow}`).value = '(Ký, họ tên)';
    ws.getCell(`E${curRow}`).font = tnr(11, false, true);
    ws.getCell(`E${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
