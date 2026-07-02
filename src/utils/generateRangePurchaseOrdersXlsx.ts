import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

/**
 * Báo cáo tổng hợp ĐẶT HÀNG theo khoảng thời gian — 4 sheet:
 *  1. Tổng quan   : số chốt kỳ + bảng theo tháng + bảng theo NCC
 *  2. Danh sách đơn: 1 dòng/đơn, sắp theo ngày tạo tăng dần (chuẩn sổ chứng từ)
 *  3. Chi tiết vật tư: 1 dòng/vật tư, theo ngày đơn → mã đơn → thứ tự dòng
 *  4. Còn thiếu — nợ NCC: sổ nợ hàng phát sinh từ các đơn trong kỳ
 * Mọi sheet: freeze dòng tiêu đề + AutoFilter + định dạng số ngăn cách nghìn.
 */

const FONT_NAME = 'Times New Roman';
const font = (bold = false, size = 11, italic = false) => ({ name: FONT_NAME, size, bold, italic });
const center = { horizontal: 'center' as const, vertical: 'middle' as const, wrapText: true };
const left = { horizontal: 'left' as const, vertical: 'middle' as const, wrapText: true };
const right = { horizontal: 'right' as const, vertical: 'middle' as const };
const thin = { style: 'thin' as const, color: { argb: 'FFB9C2D0' } };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF1F7' } };
const totalFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FB' } };
const NUM = '#,##0';
const MONEY = '#,##0';

const STATUS_LABEL: Record<string, string> = {
    draft: 'Bản nháp',
    confirmed: 'Đã xác nhận',
    ordered: 'Đang đặt hàng',
    partially_received: 'Nhận một phần',
    received: 'Đã nhận hàng',
    cancelled: 'Đã hủy',
};

const SHORTAGE_STATUS_LABEL: Record<string, string> = {
    outstanding: 'Còn nợ',
    partially_settled: 'Bù một phần',
    settled: 'Đã bù đủ',
    cancelled: 'Đã hủy',
};

const fmtDate = (value?: string | Date | null) => (value ? dayjs(value).format('DD/MM/YYYY') : '');

const orderSuppliers = (order: any) => {
    const names = new Set<string>();
    (order.items ?? []).forEach((item: any) => {
        if (item.supplierName) names.add(item.supplierName);
    });
    if (!names.size && order.supplierName) names.add(order.supplierName);
    return [...names];
};

const orderPlants = (order: any) => {
    const names = new Set<string>();
    (order.items ?? []).forEach((item: any) => {
        if (item.plantName) names.add(item.plantName);
    });
    return [...names];
};

const addCompanyHeader = (ws: ExcelJS.Worksheet, lastCol: string, title: string, periodLabel: string) => {
    ws.mergeCells(`A1:${lastCol}1`);
    const r1 = ws.getCell('A1');
    r1.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    r1.font = font(true, 13);
    r1.alignment = left;

    ws.mergeCells(`A2:${lastCol}2`);
    const r2 = ws.getCell('A2');
    r2.value = 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
    r2.font = font(false, 11, true);
    r2.alignment = left;

    ws.getRow(3).height = 6;

    ws.mergeCells(`A4:${lastCol}4`);
    const r4 = ws.getCell('A4');
    r4.value = title;
    r4.font = font(true, 15);
    r4.alignment = center;
    ws.getRow(4).height = 28;

    ws.mergeCells(`A5:${lastCol}5`);
    const r5 = ws.getCell('A5');
    r5.value = `Kỳ báo cáo: ${periodLabel} — Xuất lúc ${dayjs().format('HH:mm DD/MM/YYYY')}`;
    r5.font = font(false, 11, true);
    r5.alignment = center;

    ws.getRow(6).height = 6;
};

const styleHeaderRow = (row: ExcelJS.Row) => {
    row.eachCell((cell) => {
        cell.font = font(true, 10.5);
        cell.alignment = center;
        cell.border = allBorders;
        cell.fill = headerFill;
    });
    row.height = 24;
};

const styleDataCell = (cell: ExcelJS.Cell, align: 'l' | 'c' | 'r' = 'l', numFmt?: string) => {
    cell.font = font(false, 10.5);
    cell.alignment = align === 'c' ? center : align === 'r' ? right : left;
    cell.border = allBorders;
    if (numFmt) cell.numFmt = numFmt;
};

export async function generateRangePurchaseOrdersXlsx(
    orders: any[],
    shortages: any[],
    periodLabel: string
): Promise<ExcelJS.Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hai Dang MS';

    const sorted = [...orders].sort(
        (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
    );

    /* ================= SHEET 1 — TỔNG QUAN ================= */
    const s1 = workbook.addWorksheet('Tổng quan', {
        pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
    });
    s1.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 17 }, { width: 15 }, { width: 17 }];
    addCompanyHeader(s1, 'F', 'BÁO CÁO TỔNG HỢP ĐẶT HÀNG VẬT TƯ', periodLabel);

    const totalAmount = sorted.reduce((sum, o) => sum + (o.totalAmount ?? 0), 0);
    const totalVat = sorted.reduce((sum, o) => sum + (o.totalVat ?? 0), 0);
    const totalWithVat = sorted.reduce((sum, o) => sum + (o.totalWithVat ?? 0), 0);
    const receivedCount = sorted.filter((o) => o.status === 'received').length;
    const waitingCount = sorted.filter((o) => ['ordered', 'partially_received', 'confirmed'].includes(o.status)).length;
    const missingQty = sorted.reduce(
        (sum, o) => sum + (o.items ?? []).reduce((s: number, i: any) => s + (i.quantityMissing ?? 0), 0),
        0
    );
    const supplierSet = new Set(sorted.flatMap((o) => orderSuppliers(o)));

    let rowIdx = 7;
    const kpis: Array<[string, number | string, string?]> = [
        ['Tổng số đơn đặt hàng', sorted.length, NUM],
        ['Tổng tiền hàng (chưa VAT)', totalAmount, MONEY],
        ['Tổng tiền VAT', totalVat, MONEY],
        ['Tổng thanh toán (gồm VAT)', totalWithVat, MONEY],
        ['Đơn đã nhận đủ hàng', receivedCount, NUM],
        ['Đơn đang chờ nhận', waitingCount, NUM],
        ['Số lượng còn thiếu chưa nhận', missingQty, NUM],
        ['Số nhà cung cấp', supplierSet.size, NUM],
    ];
    kpis.forEach(([label, value, numFmt]) => {
        const row = s1.getRow(rowIdx);
        s1.mergeCells(`A${rowIdx}:C${rowIdx}`);
        row.getCell(1).value = label;
        styleDataCell(row.getCell(1), 'l');
        s1.mergeCells(`D${rowIdx}:F${rowIdx}`);
        row.getCell(4).value = value;
        styleDataCell(row.getCell(4), 'r', numFmt);
        row.getCell(4).font = font(true, 11);
        rowIdx += 1;
    });
    rowIdx += 1;

    // ---- Theo tháng ----
    s1.mergeCells(`A${rowIdx}:F${rowIdx}`);
    s1.getCell(`A${rowIdx}`).value = 'TỔNG HỢP THEO THÁNG';
    s1.getCell(`A${rowIdx}`).font = font(true, 12);
    rowIdx += 1;
    const monthHeader = s1.getRow(rowIdx);
    ['Tháng', 'Số đơn', 'Số dòng', 'Tiền hàng', 'VAT', 'Tổng cộng'].forEach((label, i) => {
        monthHeader.getCell(i + 1).value = label;
    });
    styleHeaderRow(monthHeader);
    rowIdx += 1;

    const byMonth = new Map<string, { orders: number; lines: number; amount: number; vat: number; total: number }>();
    sorted.forEach((o) => {
        const key = dayjs(o.createdAt).format('MM/YYYY');
        const entry = byMonth.get(key) ?? { orders: 0, lines: 0, amount: 0, vat: 0, total: 0 };
        entry.orders += 1;
        entry.lines += (o.items ?? []).length;
        entry.amount += o.totalAmount ?? 0;
        entry.vat += o.totalVat ?? 0;
        entry.total += o.totalWithVat ?? 0;
        byMonth.set(key, entry);
    });
    [...byMonth.entries()]
        .sort(([a], [b]) => dayjs(a, 'MM/YYYY').valueOf() - dayjs(b, 'MM/YYYY').valueOf())
        .forEach(([month, entry]) => {
            const row = s1.getRow(rowIdx);
            row.getCell(1).value = month;
            row.getCell(2).value = entry.orders;
            row.getCell(3).value = entry.lines;
            row.getCell(4).value = entry.amount;
            row.getCell(5).value = entry.vat;
            row.getCell(6).value = entry.total;
            styleDataCell(row.getCell(1), 'c');
            styleDataCell(row.getCell(2), 'r', NUM);
            styleDataCell(row.getCell(3), 'r', NUM);
            styleDataCell(row.getCell(4), 'r', MONEY);
            styleDataCell(row.getCell(5), 'r', MONEY);
            styleDataCell(row.getCell(6), 'r', MONEY);
            rowIdx += 1;
        });
    rowIdx += 1;

    // ---- Theo NCC ----
    s1.mergeCells(`A${rowIdx}:F${rowIdx}`);
    s1.getCell(`A${rowIdx}`).value = 'TỔNG HỢP THEO NHÀ CUNG CẤP';
    s1.getCell(`A${rowIdx}`).font = font(true, 12);
    rowIdx += 1;
    const supplierHeader = s1.getRow(rowIdx);
    ['Nhà cung cấp', 'Số đơn', 'Số dòng', 'Tổng cộng (gồm VAT)', 'SL còn thiếu', 'Tỷ trọng'].forEach((label, i) => {
        supplierHeader.getCell(i + 1).value = label;
    });
    styleHeaderRow(supplierHeader);
    rowIdx += 1;

    const bySupplier = new Map<string, { orders: Set<string>; lines: number; total: number; missing: number }>();
    sorted.forEach((o) => {
        (o.items ?? []).forEach((item: any) => {
            const key = item.supplierName || o.supplierName || 'Chưa rõ NCC';
            const entry = bySupplier.get(key) ?? { orders: new Set<string>(), lines: 0, total: 0, missing: 0 };
            entry.orders.add(o.orderCode ?? o.id);
            entry.lines += 1;
            entry.total += item.totalWithVat ?? 0;
            entry.missing += item.quantityMissing ?? 0;
            bySupplier.set(key, entry);
        });
    });
    const supplierTotal = [...bySupplier.values()].reduce((sum, e) => sum + e.total, 0) || 1;
    [...bySupplier.entries()]
        .sort(([, a], [, b]) => b.total - a.total)
        .forEach(([name, entry]) => {
            const row = s1.getRow(rowIdx);
            row.getCell(1).value = name;
            row.getCell(2).value = entry.orders.size;
            row.getCell(3).value = entry.lines;
            row.getCell(4).value = entry.total;
            row.getCell(5).value = entry.missing;
            row.getCell(6).value = `${Math.round((entry.total / supplierTotal) * 100)}%`;
            styleDataCell(row.getCell(1), 'l');
            styleDataCell(row.getCell(2), 'r', NUM);
            styleDataCell(row.getCell(3), 'r', NUM);
            styleDataCell(row.getCell(4), 'r', MONEY);
            styleDataCell(row.getCell(5), 'r', NUM);
            styleDataCell(row.getCell(6), 'r');
            if (entry.missing > 0) row.getCell(5).font = { ...font(true, 10.5), color: { argb: 'FFC0392B' } };
            rowIdx += 1;
        });

    /* ================= SHEET 2 — DANH SÁCH ĐƠN ================= */
    const s2 = workbook.addWorksheet('Danh sách đơn', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
        views: [{ state: 'frozen', ySplit: 7 }],
    });
    s2.columns = [
        { width: 5 },
        { width: 17 },
        { width: 11 },
        { width: 24 },
        { width: 16 },
        { width: 20 },
        { width: 8 },
        { width: 14 },
        { width: 12 },
        { width: 15 },
        { width: 14 },
        { width: 11 },
    ];
    addCompanyHeader(s2, 'L', 'DANH SÁCH ĐƠN ĐẶT HÀNG', periodLabel);

    const s2Header = s2.getRow(7);
    ['STT', 'Mã đơn', 'Ngày tạo', 'Nhà cung cấp', 'Cơ sở', 'Phiếu đề xuất', 'Số dòng', 'Tiền hàng', 'VAT', 'Tổng cộng', 'Trạng thái', 'Ngày nhận'].forEach(
        (label, i) => {
            s2Header.getCell(i + 1).value = label;
        }
    );
    styleHeaderRow(s2Header);
    s2.autoFilter = { from: 'A7', to: 'L7' };

    let s2Row = 8;
    sorted.forEach((o, index) => {
        const row = s2.getRow(s2Row);
        row.getCell(1).value = index + 1;
        row.getCell(2).value = o.orderCode ?? '';
        row.getCell(3).value = fmtDate(o.createdAt);
        row.getCell(4).value = orderSuppliers(o).join(', ');
        row.getCell(5).value = orderPlants(o).join(', ');
        row.getCell(6).value = (o.purchaseRequestCodes ?? []).join(', ');
        row.getCell(7).value = (o.items ?? []).length;
        row.getCell(8).value = o.totalAmount ?? 0;
        row.getCell(9).value = o.totalVat ?? 0;
        row.getCell(10).value = o.totalWithVat ?? 0;
        row.getCell(11).value = STATUS_LABEL[o.status] ?? o.status;
        row.getCell(12).value = fmtDate(o.receivedAt);
        styleDataCell(row.getCell(1), 'c');
        styleDataCell(row.getCell(2), 'l');
        styleDataCell(row.getCell(3), 'c');
        styleDataCell(row.getCell(4), 'l');
        styleDataCell(row.getCell(5), 'l');
        styleDataCell(row.getCell(6), 'l');
        styleDataCell(row.getCell(7), 'r', NUM);
        styleDataCell(row.getCell(8), 'r', MONEY);
        styleDataCell(row.getCell(9), 'r', MONEY);
        styleDataCell(row.getCell(10), 'r', MONEY);
        styleDataCell(row.getCell(11), 'c');
        styleDataCell(row.getCell(12), 'c');
        if (o.status !== 'received') row.getCell(11).font = { ...font(false, 10.5), color: { argb: 'FFB45309' } };
        s2Row += 1;
    });
    const s2Total = s2.getRow(s2Row);
    s2.mergeCells(`A${s2Row}:F${s2Row}`);
    s2Total.getCell(1).value = 'TỔNG CỘNG';
    s2Total.getCell(7).value = sorted.reduce((sum, o) => sum + (o.items ?? []).length, 0);
    s2Total.getCell(8).value = totalAmount;
    s2Total.getCell(9).value = totalVat;
    s2Total.getCell(10).value = totalWithVat;
    [1, 7, 8, 9, 10, 11, 12].forEach((col) => {
        const cell = s2Total.getCell(col);
        cell.font = font(true, 11);
        cell.border = allBorders;
        cell.fill = totalFill;
        cell.alignment = col === 1 ? center : right;
        if (col >= 7) cell.numFmt = col === 7 ? NUM : MONEY;
    });

    /* ================= SHEET 3 — CHI TIẾT VẬT TƯ ================= */
    const s3 = workbook.addWorksheet('Chi tiết vật tư', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
        views: [{ state: 'frozen', ySplit: 7 }],
    });
    s3.columns = [
        { width: 5 },
        { width: 17 },
        { width: 11 },
        { width: 20 },
        { width: 30 },
        { width: 8 },
        { width: 9 },
        { width: 9 },
        { width: 9 },
        { width: 12 },
        { width: 14 },
        { width: 7 },
        { width: 15 },
        { width: 14 },
        { width: 13 },
        { width: 13 },
    ];
    addCompanyHeader(s3, 'P', 'CHI TIẾT VẬT TƯ ĐẶT HÀNG', periodLabel);

    const s3Header = s3.getRow(7);
    ['STT', 'Mã đơn', 'Ngày', 'Nhà cung cấp', 'Tên vật tư', 'ĐVT', 'SL đặt', 'SL nhận', 'Còn thiếu', 'Đơn giá', 'Thành tiền', 'VAT %', 'Tổng có VAT', 'Cơ sở', 'Người ĐX', 'TT nhận'].forEach(
        (label, i) => {
            s3Header.getCell(i + 1).value = label;
        }
    );
    styleHeaderRow(s3Header);
    s3.autoFilter = { from: 'A7', to: 'P7' };

    const RECEIVE_LABEL: Record<string, string> = {
        pending: 'Chưa nhận',
        partially_received: 'Nhận một phần',
        received: 'Đã nhận đủ',
    };
    let s3Row = 8;
    let lineNo = 1;
    let sumOrdered = 0;
    let sumReceived = 0;
    let sumMissing = 0;
    let sumLineAmount = 0;
    let sumLineTotal = 0;
    sorted.forEach((o) => {
        (o.items ?? []).forEach((item: any) => {
            const row = s3.getRow(s3Row);
            row.getCell(1).value = lineNo;
            row.getCell(2).value = o.orderCode ?? '';
            row.getCell(3).value = fmtDate(o.createdAt);
            row.getCell(4).value = item.supplierName || '';
            row.getCell(5).value = item.materialName || '';
            row.getCell(6).value = item.unit || '';
            row.getCell(7).value = item.quantityOrdered ?? 0;
            row.getCell(8).value = item.quantityReceived ?? 0;
            row.getCell(9).value = item.quantityMissing ?? 0;
            row.getCell(10).value = item.unitPrice ?? 0;
            row.getCell(11).value = item.totalPrice ?? 0;
            row.getCell(12).value = item.vatRate ?? 0;
            row.getCell(13).value = item.totalWithVat ?? 0;
            row.getCell(14).value = item.plantName || '';
            row.getCell(15).value = item.proposedBy || '';
            row.getCell(16).value = RECEIVE_LABEL[item.receiveStatus] ?? item.receiveStatus ?? '';
            styleDataCell(row.getCell(1), 'c');
            styleDataCell(row.getCell(2), 'l');
            styleDataCell(row.getCell(3), 'c');
            styleDataCell(row.getCell(4), 'l');
            styleDataCell(row.getCell(5), 'l');
            styleDataCell(row.getCell(6), 'c');
            styleDataCell(row.getCell(7), 'r', NUM);
            styleDataCell(row.getCell(8), 'r', NUM);
            styleDataCell(row.getCell(9), 'r', NUM);
            styleDataCell(row.getCell(10), 'r', MONEY);
            styleDataCell(row.getCell(11), 'r', MONEY);
            styleDataCell(row.getCell(12), 'c');
            styleDataCell(row.getCell(13), 'r', MONEY);
            styleDataCell(row.getCell(14), 'l');
            styleDataCell(row.getCell(15), 'l');
            styleDataCell(row.getCell(16), 'c');
            if ((item.quantityMissing ?? 0) > 0) {
                row.getCell(9).font = { ...font(true, 10.5), color: { argb: 'FFC0392B' } };
            }
            sumOrdered += item.quantityOrdered ?? 0;
            sumReceived += item.quantityReceived ?? 0;
            sumMissing += item.quantityMissing ?? 0;
            sumLineAmount += item.totalPrice ?? 0;
            sumLineTotal += item.totalWithVat ?? 0;
            s3Row += 1;
            lineNo += 1;
        });
    });
    const s3Total = s3.getRow(s3Row);
    s3.mergeCells(`A${s3Row}:F${s3Row}`);
    s3Total.getCell(1).value = 'TỔNG CỘNG';
    s3Total.getCell(7).value = sumOrdered;
    s3Total.getCell(8).value = sumReceived;
    s3Total.getCell(9).value = sumMissing;
    s3Total.getCell(11).value = sumLineAmount;
    s3Total.getCell(13).value = sumLineTotal;
    [1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].forEach((col) => {
        const cell = s3Total.getCell(col);
        cell.font = font(true, 11);
        cell.border = allBorders;
        cell.fill = totalFill;
        cell.alignment = col === 1 ? center : right;
        if ([7, 8, 9].includes(col)) cell.numFmt = NUM;
        if ([11, 13].includes(col)) cell.numFmt = MONEY;
    });

    /* ================= SHEET 4 — CÒN THIẾU / NỢ NCC ================= */
    const s4 = workbook.addWorksheet('Còn thiếu - nợ NCC', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
        views: [{ state: 'frozen', ySplit: 7 }],
    });
    s4.columns = [
        { width: 5 },
        { width: 22 },
        { width: 32 },
        { width: 8 },
        { width: 17 },
        { width: 11 },
        { width: 10 },
        { width: 10 },
        { width: 10 },
        { width: 14 },
    ];
    addCompanyHeader(s4, 'J', 'SỔ NỢ HÀNG NHÀ CUNG CẤP (PHÁT SINH TRONG KỲ)', periodLabel);

    const s4Header = s4.getRow(7);
    ['STT', 'Nhà cung cấp', 'Tên vật tư', 'ĐVT', 'Đơn gốc', 'Ngày đơn', 'SL thiếu', 'Đã bù', 'Còn nợ', 'Trạng thái'].forEach(
        (label, i) => {
            s4Header.getCell(i + 1).value = label;
        }
    );
    styleHeaderRow(s4Header);
    s4.autoFilter = { from: 'A7', to: 'J7' };

    const orderDateByCode = new Map(sorted.map((o) => [o.orderCode, o.createdAt]));
    const sortedShortages = [...shortages].sort((a, b) => {
        const bySupplier = String(a.supplierName ?? '').localeCompare(String(b.supplierName ?? ''), 'vi');
        if (bySupplier !== 0) return bySupplier;
        return String(a.originalPurchaseOrderCode ?? '').localeCompare(String(b.originalPurchaseOrderCode ?? ''));
    });

    let s4Row = 8;
    if (!sortedShortages.length) {
        s4.mergeCells(`A${s4Row}:J${s4Row}`);
        const cell = s4.getCell(`A${s4Row}`);
        cell.value = 'Không phát sinh nợ hàng trong kỳ';
        cell.font = font(false, 11, true);
        cell.alignment = center;
        cell.border = allBorders;
    } else {
        sortedShortages.forEach((shortage: any, index: number) => {
            const missing = Number(shortage.quantityMissing ?? 0);
            const resolved = Number(shortage.quantityResolved ?? 0);
            const row = s4.getRow(s4Row);
            row.getCell(1).value = index + 1;
            row.getCell(2).value = shortage.supplierName || 'Chưa rõ NCC';
            row.getCell(3).value = shortage.materialName || '';
            row.getCell(4).value = shortage.unit || '';
            row.getCell(5).value = shortage.originalPurchaseOrderCode || '';
            row.getCell(6).value = fmtDate(orderDateByCode.get(shortage.originalPurchaseOrderCode));
            row.getCell(7).value = missing;
            row.getCell(8).value = resolved;
            row.getCell(9).value = Math.max(0, missing - resolved);
            row.getCell(10).value = SHORTAGE_STATUS_LABEL[shortage.status] ?? shortage.status ?? '';
            styleDataCell(row.getCell(1), 'c');
            styleDataCell(row.getCell(2), 'l');
            styleDataCell(row.getCell(3), 'l');
            styleDataCell(row.getCell(4), 'c');
            styleDataCell(row.getCell(5), 'l');
            styleDataCell(row.getCell(6), 'c');
            styleDataCell(row.getCell(7), 'r', NUM);
            styleDataCell(row.getCell(8), 'r', NUM);
            styleDataCell(row.getCell(9), 'r', NUM);
            styleDataCell(row.getCell(10), 'c');
            if (missing - resolved > 0) {
                row.getCell(9).font = { ...font(true, 10.5), color: { argb: 'FFC0392B' } };
            }
            s4Row += 1;
        });
    }

    return workbook.xlsx.writeBuffer();
}
