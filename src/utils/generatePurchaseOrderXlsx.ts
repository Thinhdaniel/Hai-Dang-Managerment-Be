import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const font = (bold = false, size = 11, italic = false) => ({
    name: 'Times New Roman' as const, size, bold, italic,
});
const center = { horizontal: 'center' as const, vertical: 'middle' as const };
const left = { horizontal: 'left' as const, vertical: 'middle' as const };
const right = { horizontal: 'right' as const, vertical: 'middle' as const };
const thin = { style: 'thin' as const };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };

async function addSheet(
    workbook: ExcelJS.Workbook,
    po: any,
    items: any[],
    sheetName: string,
    isSummary: boolean,
    supplierName?: string
) {
    const ws = workbook.addWorksheet(sheetName, {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
    });

    if (isSummary) {
        ws.columns = [
            { width: 5 }, { width: 28 }, { width: 16 }, { width: 10 }, { width: 12 },
            { width: 18 }, { width: 8 }, { width: 7 }, { width: 8 }, { width: 12 },
            { width: 14 }, { width: 6 }, { width: 13 }, { width: 14 }, { width: 16 },
        ];
    } else {
        ws.columns = [
            { width: 5 }, { width: 30 }, { width: 10 }, { width: 12 }, { width: 20 },
            { width: 8 }, { width: 7 }, { width: 8 }, { width: 12 }, { width: 14 },
            { width: 6 }, { width: 13 }, { width: 14 }, { width: 16 },
        ];
    }

    const lastCol = isSummary ? 'O' : 'N';
    const totalCols = isSummary ? 15 : 14;

    // ROW 1: Tên công ty
    ws.mergeCells(`A1:${lastCol}1`);
    const r1 = ws.getCell('A1');
    r1.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    r1.font = font(true, 13);
    r1.alignment = left;

    // ROW 2: Địa chỉ
    ws.mergeCells(`A2:${lastCol}2`);
    const r2 = ws.getCell('A2');
    r2.value = 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
    r2.font = font(false, 11, true);
    r2.alignment = left;

    // ROW 3: blank
    ws.getRow(3).height = 6;

    // ROW 4: Tiêu đề
    ws.mergeCells(`A4:${lastCol}4`);
    const r4 = ws.getCell('A4');
    r4.value = isSummary ? 'PHIẾU NHẬP HÀNG — TỔNG HỢP' : 'PHIẾU NHẬP HÀNG';
    r4.font = font(true, 16);
    r4.alignment = center;
    ws.getRow(4).height = 30;

    // ROW 5: Ngày
    ws.mergeCells(`A5:${lastCol}5`);
    const r5 = ws.getCell('A5');
    const d = dayjs(po.createdAt);
    r5.value = `Ngày ${d.format('DD')} tháng ${d.format('MM')} năm ${d.format('YYYY')}`;
    r5.font = font(false, 11, true);
    r5.alignment = center;

    // ROW 6: Mã đơn
    ws.mergeCells(`A6:${lastCol}6`);
    const r6 = ws.getCell('A6');
    r6.value = `Số: ${po.orderCode}`;
    r6.font = font(false, 11);
    r6.alignment = center;

    // ROW 7: blank
    ws.getRow(7).height = 6;

    // ROW 8-11: Thông tin
    const setInfo = (row: number, label: string, value: string) => {
        ws.getCell(`A${row}`).value = label;
        ws.getCell(`A${row}`).font = font(false, 11);
        ws.getCell(`A${row}`).alignment = left;
        ws.mergeCells(`B${row}:${lastCol}${row}`);
        ws.getCell(`B${row}`).value = value;
        ws.getCell(`B${row}`).font = font(true, 11);
        ws.getCell(`B${row}`).alignment = left;
    };

    setInfo(8, 'Nhà cung cấp:', supplierName || 'Nhiều nhà cung cấp');
    const reqCodes = (po.purchaseRequestCodes ?? []).join(', ');
    setInfo(9, 'Căn cứ đề xuất:', reqCodes);
    const createdByName = typeof po.createdBy === 'object'
        ? (po.createdBy?.fullname ?? po.createdBy?.name ?? '')
        : '';
    setInfo(10, 'Người lập:', createdByName);
    const orderedAt = po.orderedAt ? dayjs(po.orderedAt).format('DD/MM/YYYY') : '—';
    const receivedAt = po.receivedAt ? dayjs(po.receivedAt).format('DD/MM/YYYY') : '—';
    setInfo(11, 'Ngày lên đơn / Ngày nhận:', `${orderedAt}  /  ${receivedAt}`);
    if (po.note) setInfo(12, 'Ghi chú:', po.note);

    // ROW 13: Header bảng
    const headers = isSummary
        ? ['STT', 'Tên vật tư, quy cách', 'Nhà cung cấp', 'Cơ sở', 'Người ĐX', 'Mục đích sử dụng',
           'SL đề xuất', 'ĐVT', 'SL đặt mua', 'Đơn giá', 'Thành tiền', 'VAT%', 'Tiền VAT', 'Tổng tiền', 'Ghi chú']
        : ['STT', 'Tên vật tư, quy cách', 'Cơ sở', 'Người ĐX', 'Mục đích sử dụng',
           'SL đề xuất', 'ĐVT', 'SL đặt mua', 'Đơn giá', 'Thành tiền', 'VAT%', 'Tiền VAT', 'Tổng tiền', 'Ghi chú'];

    const headerRow = ws.getRow(13);
    headerRow.height = 28;
    headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = font(true, 11);
        cell.alignment = { ...center, wrapText: true };
        cell.border = allBorders;
    });

    // Data rows
    let curRow = 14;
    let sumTotalPrice = 0, sumVat = 0, sumWithVat = 0;

    items.forEach((item: any, idx: number) => {
        const row = ws.getRow(curRow);
        row.height = 22;

        const tp = item.totalPrice ?? 0;
        const va = item.vatAmount ?? 0;
        const twv = item.totalWithVat ?? 0;
        sumTotalPrice += tp;
        sumVat += va;
        sumWithVat += twv;

        const cols = isSummary
            ? [idx + 1, item.materialName ?? '', item.supplierName ?? '', item.plantName ?? '',
               item.proposedBy ?? '', item.purpose ?? '', item.quantityRequested ?? 0, item.unit ?? '',
               item.quantityOrdered ?? 0, item.unitPrice ?? 0, tp, (item.vatRate ?? 0) / 100, va, twv, item.note ?? '']
            : [idx + 1, item.materialName ?? '', item.plantName ?? '', item.proposedBy ?? '',
               item.purpose ?? '', item.quantityRequested ?? 0, item.unit ?? '',
               item.quantityOrdered ?? 0, item.unitPrice ?? 0, tp, (item.vatRate ?? 0) / 100, va, twv, item.note ?? ''];

        const moneyIdx = isSummary ? [10, 11, 13, 14] : [9, 10, 12, 13];
        const vatIdx = isSummary ? 12 : 11;
        const centerIdx = isSummary ? [1, 7, 8, 9] : [1, 6, 7, 8];

        cols.forEach((val, ci) => {
            const cell = row.getCell(ci + 1);
            cell.value = val;
            cell.font = font(false, 11);
            cell.border = allBorders;
            const colIdx = ci + 1;
            if (centerIdx.includes(colIdx)) cell.alignment = center;
            else if (moneyIdx.includes(colIdx)) { cell.alignment = right; cell.numFmt = '#,##0'; }
            else if (colIdx === vatIdx) { cell.alignment = center; cell.numFmt = '0%'; }
            else cell.alignment = { ...left, wrapText: true };
        });
        curRow++;
    });

    // Tổng cộng
    const mergeTo = isSummary ? `H${curRow}` : `G${curRow}`;
    ws.mergeCells(`A${curRow}:${mergeTo}`);
    const totalLabel = ws.getCell(`A${curRow}`);
    totalLabel.value = 'TỔNG CỘNG';
    totalLabel.font = font(true, 11);
    totalLabel.alignment = center;
    totalLabel.border = allBorders;

    const totalStartCol = isSummary ? 11 : 10;
    // Thành tiền, Tiền VAT, Tổng tiền — bỏ qua cột VAT% ở giữa
    [[totalStartCol, sumTotalPrice], [totalStartCol + 2, sumVat], [totalStartCol + 3, sumWithVat]].forEach(([col, val]) => {
        const cell = ws.getCell(curRow, col as number);
        cell.value = val;
        cell.font = font(true, 11);
        cell.numFmt = '#,##0';
        cell.alignment = right;
        cell.border = allBorders;
    });
    for (let c = 1; c <= totalCols; c++) {
        const cell = ws.getCell(curRow, c);
        if (!cell.border?.top) cell.border = allBorders;
    }

    curRow += 2;

    // Chữ ký
    const sig1End = isSummary ? 'E' : 'D';
    const sig2Start = isSummary ? 'F' : 'E';
    const sig2End = isSummary ? 'J' : 'I';
    const sig3Start = isSummary ? 'K' : 'J';

    ws.mergeCells(`A${curRow}:${sig1End}${curRow}`);
    ws.getCell(`A${curRow}`).value = 'Người lập đơn';
    ws.getCell(`A${curRow}`).font = font(true, 11);
    ws.getCell(`A${curRow}`).alignment = center;

    ws.mergeCells(`${sig2Start}${curRow}:${sig2End}${curRow}`);
    ws.getCell(`${sig2Start}${curRow}`).value = 'Người duyệt';
    ws.getCell(`${sig2Start}${curRow}`).font = font(true, 11);
    ws.getCell(`${sig2Start}${curRow}`).alignment = center;

    ws.mergeCells(`${sig3Start}${curRow}:${lastCol}${curRow}`);
    ws.getCell(`${sig3Start}${curRow}`).value = 'Đại diện NCC xác nhận';
    ws.getCell(`${sig3Start}${curRow}`).font = font(true, 11);
    ws.getCell(`${sig3Start}${curRow}`).alignment = center;

    curRow++;
    ws.getRow(curRow).height = 50;

    curRow++;
    ws.mergeCells(`A${curRow}:${sig1End}${curRow}`);
    ws.getCell(`A${curRow}`).value = '(Ký, ghi rõ họ tên)';
    ws.getCell(`A${curRow}`).font = font(false, 10, true);
    ws.getCell(`A${curRow}`).alignment = center;

    ws.mergeCells(`${sig2Start}${curRow}:${sig2End}${curRow}`);
    ws.getCell(`${sig2Start}${curRow}`).value = '(Ký, ghi rõ họ tên)';
    ws.getCell(`${sig2Start}${curRow}`).font = font(false, 10, true);
    ws.getCell(`${sig2Start}${curRow}`).alignment = center;

    ws.mergeCells(`${sig3Start}${curRow}:${lastCol}${curRow}`);
    ws.getCell(`${sig3Start}${curRow}`).value = '(Ký, ghi rõ họ tên)';
    ws.getCell(`${sig3Start}${curRow}`).font = font(false, 10, true);
    ws.getCell(`${sig3Start}${curRow}`).alignment = center;
}

export async function generatePurchaseOrderXlsx(po: any): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const items: any[] = po.items ?? [];

    const supplierMap = new Map<string, { supplierName: string; items: any[] }>();
    for (const item of items) {
        const key = item.supplierId?.toString() ?? item.supplierName ?? 'unknown';
        const name = item.supplierName || 'Chưa xác định NCC';
        if (!supplierMap.has(key)) supplierMap.set(key, { supplierName: name, items: [] });
        supplierMap.get(key)!.items.push(item);
    }

    const suppliers = Array.from(supplierMap.values());

    if (suppliers.length > 1) {
        await addSheet(workbook, po, items, 'Tổng hợp', true);
    }

    for (const sup of suppliers) {
        await addSheet(workbook, po, sup.items, sup.supplierName.slice(0, 31), false, sup.supplierName);
    }

    if (workbook.worksheets.length === 0) {
        await addSheet(workbook, po, items, 'Don dat hang', false);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
