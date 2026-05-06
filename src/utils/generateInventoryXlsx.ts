import ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import { getLogoBuffer } from '@/utils/companyAssets';

const NAVY = '1A3A5C';
const WHITE = 'FFFFFFFF';
const GRAY_TEXT = 'FF555555';
const ORANGE_TEXT = 'FFE65100';
const HINT_BG = 'FFFFF8E1';
const ALT_ROW = 'FFF9FAFB';

const COMPANY_NAME = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
const COMPANY_ADDRESS = 'Địa chỉ: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';

const navyFill = (ws: ExcelJS.Worksheet, row: number, colCount: number) => {
    for (let c = 1; c <= colCount; c++) {
        ws.getCell(row, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${NAVY}` } };
    }
};

const thinBorder = (): Partial<ExcelJS.Borders> => ({
    top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
});

async function addCompanyHeader(
    ws: ExcelJS.Worksheet,
    colCount: number,
    title: string,
    logoBuffer: Buffer | null
): Promise<void> {
    const lastCol = String.fromCharCode(64 + colCount);

    // ROW 1: Logo + Company name
    ws.mergeCells(`A1:${lastCol}1`);
    ws.getRow(1).height = 50;
    const r1 = ws.getCell('A1');
    r1.value = COMPANY_NAME;
    r1.font = { name: 'Arial', size: 13, bold: true, color: { argb: `FF${NAVY}` } };
    r1.alignment = { horizontal: 'center', vertical: 'middle' };

    if (logoBuffer) {
        const imgBuf = Buffer.from(logoBuffer) as any;
        const imgId = ws.workbook.addImage({ buffer: imgBuf, extension: 'png' });
        ws.addImage(imgId, {
            tl: { col: 0, row: 0 } as any,
            br: { col: 1, row: 1 } as any,
            editAs: 'oneCell',
        });
    }

    // ROW 2: Address
    ws.mergeCells(`A2:${lastCol}2`);
    ws.getRow(2).height = 18;
    const r2 = ws.getCell('A2');
    r2.value = COMPANY_ADDRESS;
    r2.font = { name: 'Arial', size: 10, italic: true, color: { argb: GRAY_TEXT } };
    r2.alignment = { horizontal: 'center', vertical: 'middle' };

    // ROW 3: blank
    ws.getRow(3).height = 8;

    // ROW 4: Title
    ws.mergeCells(`A4:${lastCol}4`);
    ws.getRow(4).height = 28;
    const r4 = ws.getCell('A4');
    r4.value = title;
    r4.font = { name: 'Arial', size: 14, bold: true, color: { argb: `FF${NAVY}` } };
    r4.alignment = { horizontal: 'center', vertical: 'middle' };
    r4.border = { bottom: { style: 'medium', color: { argb: `FF${NAVY}` } } };
}

// ─── IMPORT TEMPLATE ────────────────────────────────────────────────────────

export async function generateImportTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Nhập tồn kho');
    const COL_COUNT = 6;

    ws.columns = [
        { width: 6 },
        { width: 16 },
        { width: 32 },
        { width: 14 },
        { width: 14 },
        { width: 24 },
    ];

    const logo = await getLogoBuffer();
    await addCompanyHeader(ws, COL_COUNT, 'BIỂU MẪU NHẬP TỒN KHO VẬT TƯ', logo);

    // ROW 5: Hướng dẫn
    ws.mergeCells('A5:F5');
    ws.getRow(5).height = 40;
    const r5 = ws.getCell('A5');
    r5.value =
        'Hướng dẫn: Điền đúng MÃ VẬT TƯ theo danh sách hệ thống. Không thay đổi cấu trúc cột. Cột STT và Tên vật tư chỉ để tham khảo.';
    r5.font = { name: 'Arial', size: 9, italic: true, color: { argb: ORANGE_TEXT } };
    r5.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    r5.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HINT_BG } };

    // ROW 6: Header bảng
    const headers = ['STT', 'Mã vật tư*', 'Tên vật tư (tham khảo)', 'Đơn vị tính', 'Số lượng*', 'Ghi chú'];
    ws.getRow(6).height = 22;
    navyFill(ws, 6, COL_COUNT);
    headers.forEach((h, i) => {
        const cell = ws.getCell(6, i + 1);
        cell.value = h;
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = thinBorder();
    });

    // ROW 7: Dòng ví dụ
    const exampleRow = ws.getRow(7);
    exampleRow.height = 18;
    const exampleData = [1, 'MAT-001', 'Chỉ may (ví dụ)', 'Cuộn', 100, ''];
    exampleData.forEach((v, i) => {
        const cell = exampleRow.getCell(i + 1);
        cell.value = v;
        cell.alignment = { horizontal: i === 0 || i === 4 ? 'center' : 'left', vertical: 'middle' };
        cell.border = thinBorder();
    });

    // ROW 8-56: 49 dòng trống
    for (let r = 8; r <= 56; r++) {
        const row = ws.getRow(r);
        row.height = 18;
        const isAlt = r % 2 === 0;
        for (let c = 1; c <= COL_COUNT; c++) {
            const cell = row.getCell(c);
            cell.border = thinBorder();
            if (isAlt) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALT_ROW } };
            }
        }
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}

// ─── STOCK SNAPSHOT REPORT ──────────────────────────────────────────────────

export async function generateStockReport(
    stocks: Array<{
        code: string;
        name: string;
        category?: string;
        unit: string;
        currentStock: number;
        minStockLevel?: number;
    }>,
    plantName: string
): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tồn kho');
    const COL_COUNT = 8;

    ws.columns = [
        { width: 6 },
        { width: 14 },
        { width: 30 },
        { width: 16 },
        { width: 12 },
        { width: 14 },
        { width: 16 },
        { width: 14 },
    ];

    const logo = await getLogoBuffer();
    await addCompanyHeader(ws, COL_COUNT, 'BÁO CÁO TỒN KHO VẬT TƯ', logo);

    // ROW 5-6: Thông tin báo cáo
    ws.getRow(5).height = 18;
    ws.getRow(6).height = 18;
    ws.getCell('A5').value = 'Ngày xuất báo cáo:';
    ws.getCell('A5').font = { bold: true };
    ws.getCell('B5').value = dayjs().format('DD/MM/YYYY HH:mm');
    ws.getCell('A6').value = 'Cơ sở:';
    ws.getCell('A6').font = { bold: true };
    ws.getCell('B6').value = plantName;

    // ROW 7: blank
    ws.getRow(7).height = 8;

    // ROW 8: Header bảng
    const headers = ['STT', 'Mã VT', 'Tên vật tư', 'Nhóm', 'ĐVT', 'Tồn hiện tại', 'Ngưỡng tối thiểu', 'Trạng thái'];
    ws.getRow(8).height = 22;
    navyFill(ws, 8, COL_COUNT);
    headers.forEach((h, i) => {
        const cell = ws.getCell(8, i + 1);
        cell.value = h;
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = thinBorder();
    });

    // DATA rows
    let totalStock = 0;
    stocks.forEach((s, idx) => {
        const rowNum = 9 + idx;
        const row = ws.getRow(rowNum);
        row.height = 18;
        totalStock += s.currentStock;

        const minLevel = s.minStockLevel ?? 0;
        let status = 'Đủ hàng';
        let fillArgb: string | null = null;
        let fontArgb: string | null = null;

        if (s.currentStock === 0) {
            status = 'Hết hàng';
            fillArgb = 'FFFEE2E2';
            fontArgb = 'FF991B1B';
        } else if (minLevel > 0 && s.currentStock < minLevel) {
            status = 'Sắp hết';
            fillArgb = 'FFFFF3CD';
            fontArgb = 'FF856404';
        }

        const values = [idx + 1, s.code, s.name, s.category || '-', s.unit, s.currentStock, minLevel || '-', status];
        values.forEach((v, c) => {
            const cell = row.getCell(c + 1);
            cell.value = v;
            cell.border = thinBorder();
            cell.alignment = { horizontal: c === 0 || c === 5 || c === 6 ? 'center' : 'left', vertical: 'middle' };
            if (fillArgb) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
            }
            if (fontArgb) {
                cell.font = { color: { argb: fontArgb } };
            }
        });
    });

    // TỔNG CỘNG
    const totalRow = 9 + stocks.length;
    ws.mergeCells(`A${totalRow}:E${totalRow}`);
    const totalCell = ws.getCell(`A${totalRow}`);
    totalCell.value = 'TỔNG CỘNG';
    totalCell.font = { bold: true };
    totalCell.alignment = { horizontal: 'center', vertical: 'middle' };
    totalCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };

    const totalValCell = ws.getCell(`F${totalRow}`);
    totalValCell.value = totalStock;
    totalValCell.font = { bold: true };
    totalValCell.alignment = { horizontal: 'center', vertical: 'middle' };
    totalValCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };

    for (let c = 1; c <= COL_COUNT; c++) {
        ws.getCell(totalRow, c).border = thinBorder();
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}

// ─── HISTORY REPORT ─────────────────────────────────────────────────────────

export async function generateHistoryReport(
    transactions: Array<{
        createdAt: Date | string;
        materialCode?: string;
        materialName?: string;
        unit?: string;
        type: string;
        quantity: number;
        stockBefore?: number;
        stockAfter?: number;
        relatedType?: string;
        performedBy?: string;
        note?: string;
    }>,
    plantName: string,
    startDate?: string,
    endDate?: string
): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Lịch sử giao dịch');
    const COL_COUNT = 12;

    ws.columns = [
        { width: 6 },
        { width: 18 },
        { width: 12 },
        { width: 28 },
        { width: 10 },
        { width: 14 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 16 },
        { width: 18 },
        { width: 24 },
    ];

    const logo = await getLogoBuffer();
    await addCompanyHeader(ws, COL_COUNT, 'LỊCH SỬ NHẬP XUẤT VẬT TƯ', logo);

    // ROW 5-7: Thông tin
    ws.getRow(5).height = 18;
    ws.getRow(6).height = 18;
    ws.getRow(7).height = 18;
    ws.getCell('A5').value = 'Từ ngày:';
    ws.getCell('A5').font = { bold: true };
    ws.getCell('B5').value = startDate ? dayjs(startDate).format('DD/MM/YYYY') : '-';
    ws.getCell('C5').value = 'Đến ngày:';
    ws.getCell('C5').font = { bold: true };
    ws.getCell('D5').value = endDate ? dayjs(endDate).format('DD/MM/YYYY') : '-';
    ws.getCell('A6').value = 'Cơ sở:';
    ws.getCell('A6').font = { bold: true };
    ws.getCell('B6').value = plantName;

    // ROW 8: blank
    ws.getRow(8).height = 8;

    // ROW 9: Header bảng
    const headers = [
        'STT', 'Ngày giờ', 'Mã VT', 'Tên vật tư', 'ĐVT',
        'Loại', 'Số lượng', 'Tồn trước', 'Tồn sau',
        'Nguồn', 'Người thực hiện', 'Ghi chú',
    ];
    ws.getRow(9).height = 22;
    navyFill(ws, 9, COL_COUNT);
    headers.forEach((h, i) => {
        const cell = ws.getCell(9, i + 1);
        cell.value = h;
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = thinBorder();
    });

    const typeLabel = (t: string) => {
        if (t === 'import') return 'Nhập kho';
        if (t === 'export') return 'Xuất kho';
        return 'Điều chỉnh';
    };
    const typeColor = (t: string) => {
        if (t === 'import') return 'FF166534';
        if (t === 'export') return 'FF991B1B';
        return 'FF92400E';
    };
    const relatedLabel = (r?: string) => {
        if (r === 'purchase_order') return 'Đơn hàng';
        if (r === 'distribution') return 'Cấp phát';
        return 'Thủ công';
    };

    let totalImport = 0;
    let totalExport = 0;

    transactions.forEach((t, idx) => {
        const rowNum = 10 + idx;
        const row = ws.getRow(rowNum);
        row.height = 18;

        const qty = Number(t.quantity ?? 0);
        const displayQty = t.type === 'export' ? (qty > 0 ? -qty : qty) : qty;
        const sign = displayQty > 0 ? '+' : '';

        if (t.type === 'import') totalImport += Math.abs(qty);
        if (t.type === 'export') totalExport += Math.abs(qty);

        const values = [
            idx + 1,
            dayjs(t.createdAt).format('DD/MM/YYYY HH:mm'),
            t.materialCode || '-',
            t.materialName || '-',
            t.unit || '-',
            typeLabel(t.type),
            `${sign}${qty.toLocaleString('vi-VN')}`,
            t.stockBefore ?? '-',
            t.stockAfter ?? '-',
            relatedLabel(t.relatedType),
            t.performedBy || '-',
            t.note || '',
        ];

        values.forEach((v, c) => {
            const cell = row.getCell(c + 1);
            cell.value = v;
            cell.border = thinBorder();
            cell.alignment = { horizontal: c === 0 || c === 6 || c === 7 || c === 8 ? 'center' : 'left', vertical: 'middle' };
            // Color by type for type column (index 5) and quantity (index 6)
            if (c === 5 || c === 6) {
                cell.font = { color: { argb: typeColor(t.type) }, bold: c === 6 };
            }
        });
    });

    // TỔNG CỘNG
    const totalRow = 10 + transactions.length;
    ws.mergeCells(`A${totalRow}:E${totalRow}`);
    ws.getCell(`A${totalRow}`).value = 'TỔNG CỘNG';
    ws.getCell(`A${totalRow}`).font = { bold: true };
    ws.getCell(`A${totalRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${totalRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };

    ws.getCell(`F${totalRow}`).value = 'Nhập / Xuất / Net';
    ws.getCell(`F${totalRow}`).font = { bold: true };
    ws.getCell(`G${totalRow}`).value = `+${totalImport.toLocaleString('vi-VN')} / -${totalExport.toLocaleString('vi-VN')} / ${(totalImport - totalExport).toLocaleString('vi-VN')}`;
    ws.getCell(`G${totalRow}`).font = { bold: true };

    for (let c = 1; c <= COL_COUNT; c++) {
        const cell = ws.getCell(totalRow, c);
        cell.border = thinBorder();
        if (c <= 5) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
        }
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}
