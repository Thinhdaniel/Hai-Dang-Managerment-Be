import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const thin = { style: 'thin' as const };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const cell = (ws: ExcelJS.Worksheet, addr: string) => ws.getCell(addr);

const setInfo = (ws: ExcelJS.Worksheet, labelCell: string, valueStart: string, valueEnd: string, label: string, value: string) => {
    cell(ws, labelCell).value = label;
    cell(ws, labelCell).font = { name: FONT, size: 11 };
    ws.mergeCells(`${valueStart}:${valueEnd}`);
    cell(ws, valueStart).value = value;
    cell(ws, valueStart).font = { name: FONT, size: 11, bold: true };
};

export const generateDistributionXlsx = async (distribution: any): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Phiếu cấp phát', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    });

    // 11 columns: STT | Tên VT | ĐVT | SL yêu cầu | SL thực xuất | Đơn giá | Thành tiền | VAT% | Tiền VAT | Tổng tiền | Ghi chú
    ws.columns = [
        { width: 6 },   // A STT
        { width: 30 },  // B Tên vật tư
        { width: 9 },   // C ĐVT
        { width: 12 },  // D SL yêu cầu
        { width: 12 },  // E SL thực xuất
        { width: 14 },  // F Đơn giá
        { width: 16 },  // G Thành tiền
        { width: 8 },   // H VAT%
        { width: 14 },  // I Tiền VAT
        { width: 16 },  // J Tổng tiền
        { width: 22 },  // K Ghi chú
    ];

    // ── Header ────────────────────────────────────────────────────────────────
    ws.mergeCells('A1:D1');
    cell(ws, 'A1').value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    cell(ws, 'A1').font = { name: FONT, size: 12, bold: true };

    ws.mergeCells('A2:D2');
    cell(ws, 'A2').value = 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
    cell(ws, 'A2').font = { name: FONT, size: 11, italic: true };

    ws.mergeCells('A4:K4');
    cell(ws, 'A4').value = 'PHIẾU CẤP PHÁT VẬT TƯ';
    cell(ws, 'A4').font = { name: FONT, size: 18, bold: true };
    cell(ws, 'A4').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.mergeCells('A5:K5');
    const d = dayjs(distribution.createdAt);
    cell(ws, 'A5').value = `Ngày ${d.format('DD')} tháng ${d.format('MM')} năm ${d.format('YYYY')}`;
    cell(ws, 'A5').font = { name: FONT, size: 11, italic: true };
    cell(ws, 'A5').alignment = { horizontal: 'center' };

    ws.mergeCells('A6:K6');
    cell(ws, 'A6').value = `Số: ${distribution.distributionCode || ''}`;
    cell(ws, 'A6').font = { name: FONT, size: 11 };
    cell(ws, 'A6').alignment = { horizontal: 'center' };

    // ── Info rows ─────────────────────────────────────────────────────────────
    // distribution is now a serialized plain object (from serializeDistributionRecord)
    const srCode = (distribution.supplyRequest as any)?.requestCode || '';
    const fromName = (distribution.fromPlant as any)?.name || '';
    const toName = (distribution.toPlant as any)?.name || '';
    const distributedByName = (distribution.distributedBy as any)?.name || '';
    const confirmedByName = (distribution.confirmedBy as any)?.name || '';

    console.log('[XLSX DEBUG] items:', JSON.stringify(distribution.items?.map((i: any) => ({
        materialName: i.materialName, unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice,
    }))));

    setInfo(ws, 'A8', 'B8', 'K8', 'Căn cứ đề xuất:', srCode);
    setInfo(ws, 'A9', 'B9', 'K9', 'Xuất tại kho:', fromName);
    setInfo(ws, 'A10', 'B10', 'K10', 'Nhập tại kho:', toName);
    setInfo(ws, 'A11', 'B11', 'F11', 'Người cấp phát:', distributedByName);
    setInfo(ws, 'G11', 'H11', 'K11', 'Người nhận:', confirmedByName);

    // ── Table header row 13 ───────────────────────────────────────────────────
    const HEADERS = ['STT', 'Tên vật tư', 'ĐVT', 'SL yêu cầu', 'SL thực xuất', 'Đơn giá', 'Thành tiền', 'VAT%', 'Tiền VAT', 'Tổng tiền', 'Ghi chú'];
    const hRow = ws.getRow(13);
    hRow.height = 28;
    HEADERS.forEach((h, i) => {
        const c = hRow.getCell(i + 1);
        c.value = h;
        c.font = { name: FONT, size: 11, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.border = border;
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    });

    // ── Data rows ─────────────────────────────────────────────────────────────
    const items: any[] = distribution.items || [];
    let currentRow = 14;
    let sumTotal = 0;

    items.forEach((item: any, idx: number) => {
        const qty = Number(item.quantity ?? 0);
        const qtyReq = Number(item.quantityRequested ?? qty);
        const unitPrice = Number(item.unitPrice ?? 0);
        const totalPrice = Number(item.totalPrice ?? qty * unitPrice);
        const vatRate = Number(item.vatRate ?? 0);
        const vatAmount = Number(item.vatAmount ?? totalPrice * vatRate / 100);
        const totalWithVat = Number(item.totalWithVat ?? totalPrice + vatAmount);
        sumTotal += totalWithVat;

        const r = ws.getRow(currentRow);
        const vals = [
            idx + 1,
            item.materialName ?? item.material?.name ?? '---',
            item.unit ?? item.material?.unit ?? '---',
            qtyReq,
            qty,
            unitPrice,
            totalPrice,
            vatRate,
            vatAmount,
            totalWithVat,
            item.adjustReason ?? item.note ?? '',
        ];
        vals.forEach((v, i) => {
            const c = r.getCell(i + 1);
            c.value = v;
            c.font = { name: FONT, size: 11 };
            c.border = border;
            // Number formatting
            if (i === 0) c.alignment = { horizontal: 'center', vertical: 'middle' };
            else if (i === 1 || i === 10) c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            else if (i === 2) c.alignment = { horizontal: 'center', vertical: 'middle' };
            else { c.alignment = { horizontal: 'right', vertical: 'middle' }; c.numFmt = '#,##0'; }
        });
        currentRow++;
    });

    // ── Totals row ────────────────────────────────────────────────────────────
    ws.mergeCells(`A${currentRow}:I${currentRow}`);
    const tLabel = ws.getCell(`A${currentRow}`);
    tLabel.value = 'TỔNG CỘNG';
    tLabel.font = { name: FONT, size: 11, bold: true };
    tLabel.alignment = { horizontal: 'center', vertical: 'middle' };
    tLabel.border = border;

    const tVal = ws.getCell(`J${currentRow}`);
    tVal.value = sumTotal;
    tVal.font = { name: FONT, size: 11, bold: true };
    tVal.numFmt = '#,##0';
    tVal.alignment = { horizontal: 'right', vertical: 'middle' };
    tVal.border = border;

    ws.getCell(`K${currentRow}`).border = border;

    // ── Signatures ────────────────────────────────────────────────────────────
    const sigRow = currentRow + 2;
    const nameRow = sigRow + 4;

    const sig = (col: string, label: string, name: string) => {
        cell(ws, `${col}${sigRow}`).value = label;
        cell(ws, `${col}${sigRow}`).font = { name: FONT, size: 11, bold: true };
        cell(ws, `${col}${sigRow}`).alignment = { horizontal: 'center' };
        cell(ws, `${col}${nameRow}`).value = name;
        cell(ws, `${col}${nameRow}`).font = { name: FONT, size: 11 };
        cell(ws, `${col}${nameRow}`).alignment = { horizontal: 'center' };
    };

    sig('B', 'Người lập phiếu', '');
    sig('F', 'Người nhận hàng', confirmedByName);
    sig('J', 'Thủ kho xuất', distributedByName);

    const buf = await workbook.xlsx.writeBuffer();
    return Buffer.from(buf);
};
