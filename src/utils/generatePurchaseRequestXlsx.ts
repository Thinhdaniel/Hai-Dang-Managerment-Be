import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const thin = { style: 'thin' as const };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
const tnr = (size = 11, bold = false, italic = false) => ({
    name: 'Times New Roman' as const, size, bold, italic,
});

export async function generatePurchaseRequestXlsx(pr: any): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Phiếu đề nghị mua', {
        pageSetup: {
            paperSize: 9,
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
    });

    // 11 columns: STT | Tên VT | Người ĐX | Mục đích | SL cần | ĐVT | SL mua | Đơn giá | Thành tiền | VAT% | Giá VAT | Tổng tiền
    ws.columns = [
        { width: 5 },  // A STT
        { width: 28 }, // B Tên vật tư
        { width: 13 }, // C Người đề xuất
        { width: 20 }, // D Mục đích
        { width: 8 },  // E SL cần
        { width: 7 },  // F ĐVT
        { width: 8 },  // G SL mua
        { width: 12 }, // H Đơn giá
        { width: 14 }, // I Thành tiền
        { width: 6 },  // J VAT%
        { width: 13 }, // K Giá VAT
        { width: 14 }, // L Tổng tiền
    ];

    const LAST = 'L';
    const COLS = 12;

    // ROW 1: Company name
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
    r4.value = 'PHIẾU ĐỀ NGHỊ MUA VẬT TƯ';
    r4.font = tnr(18, true);
    r4.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(4).height = 30;

    // ROW 5: Date
    ws.mergeCells(`A5:${LAST}5`);
    const r5 = ws.getCell('A5');
    const d = dayjs(pr.createdAt);
    r5.value = `Ngày ${d.format('DD')} tháng ${d.format('MM')} năm ${d.format('YYYY')}`;
    r5.font = tnr(11, false, true);
    r5.alignment = { horizontal: 'center', vertical: 'middle' };

    // ROW 6: Code
    ws.mergeCells(`A6:${LAST}6`);
    const r6 = ws.getCell('A6');
    r6.value = `Số: ${pr.requestCode || ''}`;
    r6.font = tnr(11);
    r6.alignment = { horizontal: 'center', vertical: 'middle' };

    // ROW 7: blank
    ws.getRow(7).height = 6;

    // ROW 8-10: Info
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

    setLabel('A8', 'Mã phiếu:');
    setValue('B8', pr.requestCode || '', `${LAST}8`);

    setLabel('A9', 'Tháng/Năm:');
    setValue('B9', pr.requestMonth && pr.requestYear ? `${pr.requestMonth}/${pr.requestYear}` : '', `${LAST}9`);

    setLabel('A10', 'Cơ sở:');
    setValue('B10', pr.plant?.name || '', `${LAST}10`);

    // ROW 12: Table header
    const headers = [
        'STT', 'Tên vật tư, quy cách', 'Người đề xuất', 'Mục đích sử dụng',
        'SL cần', 'ĐVT', 'SL mua', 'Đơn giá', 'Thành tiền', 'VAT%', 'Giá VAT', 'Tổng tiền',
    ];
    const headerRow = ws.getRow(12);
    headerRow.height = 25;
    headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = tnr(11, true);
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = allBorders;
    });

    // DATA ROWS
    let curRow = 13;
    let sumTotal = 0, sumVat = 0, sumWithVat = 0;
    const fmt = (n?: number) => (n != null ? n : '');

    (pr.items ?? []).forEach((item: any, idx: number) => {
        const row = ws.getRow(curRow);
        const tp = item.totalPrice ?? 0;
        const va = item.vatAmount ?? 0;
        const twv = item.totalWithVat ?? 0;
        sumTotal += tp;
        sumVat += va;
        sumWithVat += twv;

        const vals: any[] = [
            idx + 1,
            item.materialName ?? '',
            item.proposedBy ?? '',
            item.purpose ?? '',
            item.quantityRequested ?? 0,
            item.unit ?? '',
            item.quantityOrdered ?? item.quantityRequested ?? 0,
            fmt(item.unitPrice),
            fmt(tp),
            item.vatRate != null ? (item.vatRate > 1 ? item.vatRate / 100 : item.vatRate) : 0,
            fmt(va),
            fmt(twv),
        ];

        vals.forEach((v, c) => {
            const cell = row.getCell(c + 1);
            cell.value = v;
            cell.font = tnr(11);
            cell.border = allBorders;
            // Alignment
            if ([0, 4, 5, 6, 9].includes(c)) {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else if ([7, 8, 10, 11].includes(c)) {
                cell.alignment = { horizontal: 'right', vertical: 'middle' };
                cell.numFmt = '#,##0';
            } else {
                cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            }
            if (c === 9) cell.numFmt = '0%';
        });
        curRow++;
    });

    // TOTAL ROW
    ws.mergeCells(`A${curRow}:H${curRow}`);
    const totalLabel = ws.getCell(`A${curRow}`);
    totalLabel.value = 'Tổng cộng:';
    totalLabel.font = tnr(11, true);
    totalLabel.alignment = { horizontal: 'center', vertical: 'middle' };

    [[9, sumTotal], [11, sumVat], [12, sumWithVat]].forEach(([col, val]) => {
        const cell = ws.getCell(curRow, col as number);
        cell.value = val;
        cell.font = tnr(11, true);
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });

    for (let c = 1; c <= COLS; c++) {
        ws.getCell(curRow, c).border = allBorders;
    }

    curRow += 2;

    // SIGNATURE
    ws.mergeCells(`A${curRow}:D${curRow}`);
    ws.getCell(`A${curRow}`).value = 'Người lập phiếu';
    ws.getCell(`A${curRow}`).font = tnr(11, true);
    ws.getCell(`A${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`E${curRow}:H${curRow}`);
    ws.getCell(`E${curRow}`).value = 'Người phê duyệt';
    ws.getCell(`E${curRow}`).font = tnr(11, true);
    ws.getCell(`E${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`I${curRow}:${LAST}${curRow}`);
    ws.getCell(`I${curRow}`).value = 'Kế toán / Thủ kho';
    ws.getCell(`I${curRow}`).font = tnr(11, true);
    ws.getCell(`I${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    curRow++;
    ws.getRow(curRow).height = 60;

    curRow++;
    ws.mergeCells(`A${curRow}:D${curRow}`);
    ws.getCell(`A${curRow}`).value = '(Ký, họ tên)';
    ws.getCell(`A${curRow}`).font = tnr(11, false, true);
    ws.getCell(`A${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`E${curRow}:H${curRow}`);
    ws.getCell(`E${curRow}`).value = '(Ký, họ tên)';
    ws.getCell(`E${curRow}`).font = tnr(11, false, true);
    ws.getCell(`E${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells(`I${curRow}:${LAST}${curRow}`);
    ws.getCell(`I${curRow}`).value = '(Ký, họ tên)';
    ws.getCell(`I${curRow}`).font = tnr(11, false, true);
    ws.getCell(`I${curRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
