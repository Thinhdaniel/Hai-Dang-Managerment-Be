import ExcelJS from 'exceljs';

const COLORS = {
    ink: 'FF17211B',
    muted: 'FF404040',
    caption: 'FF808080',
    primary: 'FF2E5FA3', // xanh header (khớp mẫu công ty)
    primaryDark: 'FF1F3864', // navy tiêu đề + dòng tổng
    primarySoft: 'FFDCE6F1', // nền dòng TỔNG
    zebra: 'FFF2F6FC', // nền dòng chẵn
    highlight: 'FFFFF2A8', // ô nhấn (ngày)
    border: 'FFC9D3E0',
    white: 'FFFFFFFF',
    warning: 'FFFFF3D8',
    danger: 'FFFDE8E8',
};

const COMPANY_NAME = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
const COMPANY_ADDRESS = 'Địa chỉ: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';

/**
 * Nhãn khung giờ dạng dải "7-8h" tính từ mốc phút — khớp mẫu Excel của xưởng và
 * đồng bộ với FE. Không dùng `slot.label` vì đó là nhãn điểm ("8h") chỉ mốc BÁO
 * CÁO, không phải khoảng làm việc; nhãn cũ còn nằm trong dữ liệu đã lưu.
 */
const slotRangeLabel = (slot: any) => {
    const start = Number(slot?.startMinute);
    const end = Number(slot?.endMinute);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return slot?.label || '';
    const text = (minute: number) => {
        const hour = Math.floor(minute / 60);
        const rest = minute % 60;
        return rest === 0 ? `${hour}` : `${hour}h${String(rest).padStart(2, '0')}`;
    };
    return start % 60 === 0 && end % 60 === 0 ? `${text(start)}-${text(end)}h` : `${text(start)}-${text(end)}`;
};

const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } },
};

const statusLabel = (status: string) =>
    ({ draft: 'Nháp', submitted: 'Chờ duyệt', locked: 'Đã khóa sổ' })[status] || status;

const formatProductionDate = (value: string) => {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
};

const configureSheet = (sheet: ExcelJS.Worksheet, orientation: 'portrait' | 'landscape' = 'landscape') => {
    sheet.properties.defaultRowHeight = 19;
    sheet.pageSetup = {
        paperSize: 9,
        orientation,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.28, right: 0.28, top: 0.45, bottom: 0.45, header: 0.18, footer: 0.18 },
    };
    sheet.headerFooter.oddFooter = '&L Hải Đăng Production&CTrang &P/&N&R&D &T';
};

const styleTitle = (sheet: ExcelJS.Worksheet, lastColumn: number, title: string, subtitle?: string) => {
    sheet.mergeCells(1, 1, 1, lastColumn);
    const companyCell = sheet.getCell(1, 1);
    companyCell.value = COMPANY_NAME;
    companyCell.font = { bold: true, size: 12, color: { argb: COLORS.primaryDark } };
    companyCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 23;

    sheet.mergeCells(2, 1, 2, lastColumn);
    const titleCell = sheet.getCell(2, 1);
    titleCell.value = title;
    titleCell.font = { bold: true, size: 17, color: { argb: COLORS.ink } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(2).height = 29;

    if (subtitle) {
        sheet.mergeCells(3, 1, 3, lastColumn);
        const subtitleCell = sheet.getCell(3, 1);
        subtitleCell.value = subtitle;
        subtitleCell.font = { italic: true, size: 10, color: { argb: COLORS.muted } };
        subtitleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        sheet.getRow(3).height = 25;
    }
};

const styleHeader = (row: ExcelJS.Row) => {
    row.height = 30;
    row.eachCell((cell) => {
        cell.font = { bold: true, size: 10, color: { argb: COLORS.white } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primary } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = thinBorder;
    });
};

const styleDataArea = (sheet: ExcelJS.Worksheet, fromRow: number, toRow: number, toColumn: number) => {
    for (let rowIndex = fromRow; rowIndex <= toRow; rowIndex += 1) {
        const row = sheet.getRow(rowIndex);
        row.eachCell({ includeEmpty: true }, (cell, column) => {
            if (column > toColumn) return;
            cell.border = thinBorder;
            cell.alignment = {
                vertical: 'middle',
                horizontal: column <= 3 ? 'left' : 'right',
                wrapText: column <= 3,
            };
        });
    }
};

const runRowsForDay = (detail: any) =>
    detail.lines.flatMap((line: any) =>
        line.runs.map((run: any) => {
            const entries = line.entries.filter((entry: any) => entry.runId === run.id);
            const slotQuantities = Object.fromEntries(
                detail.timeSlots.map((slot: any) => [
                    slot.key,
                    entries
                        .filter((entry: any) => entry.slotKey === slot.key)
                        .reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0),
                ])
            );
            const target = line.slotValues
                .filter((slot: any) => slot.runId === run.id)
                .reduce((sum: number, slot: any) => sum + Number(slot.target || 0), 0);
            const actual = entries.reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
            const amount = entries.reduce((sum: number, entry: any) => sum + Number(entry.amount || 0), 0);
            return { line, run, slotQuantities, target, actual, amount };
        })
    );

const addDailyReportSheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const sheet = workbook.addWorksheet('BC NGAY');
    configureSheet(sheet, 'landscape');
    const facility = detail.plantName || 'Cơ sở';

    // Khung giờ dùng cho khối tổng theo giờ (chỉ các khung đang bật)
    const activeSlots = (detail.timeSlots || []).filter((slot: any) => slot.isActive);
    const slotSectionWidth = Math.max(8, activeSlots.length + 1);

    // ----- Letterhead -----
    sheet.mergeCells(1, 1, 1, slotSectionWidth);
    const companyCell = sheet.getCell(1, 1);
    companyCell.value = `${COMPANY_NAME} – ${facility.toUpperCase()}`;
    companyCell.font = { bold: true, size: 13, color: { argb: COLORS.primaryDark } };
    companyCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    sheet.getRow(1).height = 20;

    sheet.mergeCells(2, 1, 2, slotSectionWidth);
    const addressCell = sheet.getCell(2, 1);
    addressCell.value = COMPANY_ADDRESS;
    addressCell.font = { italic: true, size: 10, color: { argb: COLORS.muted } };
    addressCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    sheet.getRow(2).height = 18;

    // ----- Tiêu đề -----
    sheet.mergeCells(4, 1, 4, slotSectionWidth);
    const titleCell = sheet.getCell(4, 1);
    titleCell.value = 'BÁO CÁO SẢN LƯỢNG NGÀY';
    titleCell.font = { bold: true, size: 16, color: { argb: COLORS.primaryDark } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(4).height = 26;

    // ----- Dòng ngày báo cáo (nhấn vàng như mẫu) -----
    sheet.getRow(6).height = 20;
    const dateLabel = sheet.getCell(6, 1);
    dateLabel.value = 'Ngày báo cáo:';
    dateLabel.font = { bold: true, size: 11, color: { argb: COLORS.ink } };
    dateLabel.alignment = { horizontal: 'right', vertical: 'middle' };
    const dateCell = sheet.getCell(6, 2);
    dateCell.value = formatProductionDate(detail.productionDate);
    dateCell.font = { bold: true, size: 11, color: { argb: 'FF0000FF' } };
    dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.highlight } };
    dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dateCell.border = thinBorder;
    const statusCell = sheet.getCell(6, 4);
    statusCell.value = `Trạng thái: ${statusLabel(detail.status)}`;
    statusCell.font = { italic: true, size: 10, color: { argb: COLORS.muted } };
    statusCell.alignment = { horizontal: 'left', vertical: 'middle' };

    // ----- Bảng tổng hợp theo chuyền -----
    const headers = [
        'Chuyền',
        'Tổ trưởng',
        'Số mã hàng',
        'SL khoán (SP)',
        'SL thực tế (SP)',
        '% đạt',
        'Thành tiền (đ)',
        'TN BQ (đ/người)',
    ];
    const headerRowIndex = 8;
    const headerRow = sheet.getRow(headerRowIndex);
    headerRow.values = headers;
    styleHeader(headerRow);

    detail.lines.forEach((line: any, index: number) => {
        const row = sheet.addRow([
            line.lineCode,
            line.leaderName || '',
            line.runs.length,
            line.totalTarget,
            line.totalActual,
            line.totalTarget > 0 ? line.totalActual / line.totalTarget : 0,
            line.totalAmount,
            line.averageIncome,
        ]);
        row.height = 18;
        row.getCell(1).font = { bold: true, size: 10, color: { argb: COLORS.ink } };
        if (index % 2 === 1) {
            row.eachCell({ includeEmpty: true }, (cell, column) => {
                if (column > headers.length) return;
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
            });
        }
        [5, 6].forEach((column) => (row.getCell(column).font = { bold: true, size: 10, color: { argb: COLORS.ink } }));
    });

    const totalRow = sheet.addRow([
        'TỔNG',
        '',
        detail.summary.itemCount,
        detail.summary.totalTarget,
        detail.summary.totalActual,
        detail.summary.totalTarget > 0 ? detail.summary.totalActual / detail.summary.totalTarget : 0,
        detail.summary.totalAmount,
        '',
    ]);
    totalRow.height = 20;
    totalRow.font = { bold: true, size: 11, color: { argb: COLORS.primaryDark } };
    totalRow.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column > headers.length) return;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
    });

    styleDataArea(sheet, headerRowIndex + 1, totalRow.number, headers.length);
    // Bảng chuyền căn giữa toàn bộ để khớp mẫu (ghi đè căn trái mặc định)
    for (let rowIndex = headerRowIndex + 1; rowIndex <= totalRow.number; rowIndex += 1) {
        sheet.getRow(rowIndex).eachCell({ includeEmpty: true }, (cell, column) => {
            if (column > headers.length) return;
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: column <= 2 };
        });
    }

    // ----- Khối sản lượng toàn xưởng theo khung giờ -----
    const slotTitleRowIndex = totalRow.number + 2;
    sheet.mergeCells(slotTitleRowIndex, 1, slotTitleRowIndex, slotSectionWidth);
    const slotTitleCell = sheet.getCell(slotTitleRowIndex, 1);
    slotTitleCell.value = 'SẢN LƯỢNG THỰC TẾ TOÀN XƯỞNG THEO KHUNG GIỜ';
    slotTitleCell.font = { bold: true, size: 11, color: { argb: COLORS.primaryDark } };
    slotTitleCell.alignment = { horizontal: 'left', vertical: 'middle' };

    const slotHeaderRowIndex = slotTitleRowIndex + 1;
    const slotHeaderRow = sheet.getRow(slotHeaderRowIndex);
    slotHeaderRow.values = [...activeSlots.map((slot: any) => slotRangeLabel(slot)), 'Tổng'];
    slotHeaderRow.height = 18;
    slotHeaderRow.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column > slotSectionWidth) return;
        cell.font = { bold: true, size: 10, color: { argb: COLORS.white } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primary } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = thinBorder;
    });

    const slotTotals = activeSlots.map((slot: any) =>
        detail.lines.reduce(
            (sum: number, line: any) =>
                sum +
                (line.entries || [])
                    .filter((entry: any) => entry.slotKey === slot.key)
                    .reduce((acc: number, entry: any) => acc + Number(entry.quantity || 0), 0),
            0
        )
    );
    const slotGrandTotal = slotTotals.reduce((sum: number, value: number) => sum + value, 0);
    const slotValueRowIndex = slotHeaderRowIndex + 1;
    const slotValueRow = sheet.getRow(slotValueRowIndex);
    slotValueRow.values = [...slotTotals, slotGrandTotal];
    slotValueRow.height = 18;
    slotValueRow.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column > slotSectionWidth) return;
        cell.numFmt = '#,##0';
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (column === slotSectionWidth) {
            cell.font = { bold: true, size: 10, color: { argb: COLORS.primaryDark } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
        } else {
            cell.font = { size: 10, color: { argb: COLORS.ink } };
        }
    });

    // ----- Khối chữ ký -----
    const signRowIndex = slotValueRowIndex + 3;
    const signBlocks: Array<[string, number, number]> = [
        ['NGƯỜI LẬP BIỂU', 2, 3],
        ['QUẢN ĐỐC XƯỞNG', 4, 5],
        ['GIÁM ĐỐC CƠ SỞ', 7, 8],
    ];
    signBlocks.forEach(([label, from, to]) => {
        sheet.mergeCells(signRowIndex, from, signRowIndex, to);
        const cell = sheet.getCell(signRowIndex, from);
        cell.value = label;
        cell.font = { bold: true, size: 11, color: { argb: COLORS.ink } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.mergeCells(signRowIndex + 1, from, signRowIndex + 1, to);
        const note = sheet.getCell(signRowIndex + 1, from);
        note.value = '(Ký, họ tên)';
        note.font = { italic: true, size: 9, color: { argb: COLORS.caption } };
        note.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // ----- Kích thước cột & định dạng số -----
    const widths = [10, 16, 11, 13, 13, 9, 16, 15];
    widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
    for (let column = 9; column <= slotSectionWidth; column += 1) sheet.getColumn(column).width = 8;
    sheet.getColumn(6).numFmt = '0.0%';
    [4, 5, 7, 8].forEach((column) => (sheet.getColumn(column).numFmt = '#,##0'));
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(slotSectionWidth).letter}${signRowIndex + 1}`;
};

const addEntryLedgerSheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const activeSlots = detail.timeSlots.filter((slot: any) => slot.isActive);
    const headers = [
        'Ngày',
        'Chuyền',
        'Tổ trưởng',
        'Mã hàng',
        'Tên hàng',
        'Số CN',
        'Đơn giá (đ)',
        'Khoán/giờ',
        ...activeSlots.map((slot: any) => slotRangeLabel(slot)),
        'Tổng khoán',
        'Tổng thực tế',
        '% đạt',
        'Thành tiền (đ)',
        'TN BQ (đ/người)',
    ];
    const sheet = workbook.addWorksheet('NHAP LIEU');
    configureSheet(sheet, 'landscape');
    styleTitle(
        sheet,
        headers.length,
        'SỔ NHẬP LIỆU SẢN LƯỢNG',
        `${detail.plantName || 'Cơ sở'} · Mỗi dòng là một mã hàng chạy trên một chuyền`
    );
    const headerRow = sheet.getRow(5);
    headerRow.values = headers;
    styleHeader(headerRow);

    runRowsForDay(detail).forEach(({ line, run, slotQuantities, target, actual, amount }: any) => {
        sheet.addRow([
            formatProductionDate(detail.productionDate),
            line.lineCode,
            line.leaderName || '',
            run.itemCode,
            run.itemName || '',
            line.workerCount,
            run.unitPriceSnapshot,
            run.hourlyQuota,
            ...activeSlots.map((slot: any) => slotQuantities[slot.key] || 0),
            target,
            actual,
            target > 0 ? actual / target : 0,
            amount,
            line.workerCount > 0 ? amount / line.workerCount : 0,
        ]);
    });

    const lastRow = Math.max(6, sheet.rowCount);
    styleDataArea(sheet, 6, lastRow, headers.length);
    sheet.columns.forEach((column, index) => {
        column.width = index === 4 ? 23 : index === 2 ? 18 : index >= 8 && index < 8 + activeSlots.length ? 9 : 13;
    });
    for (let column = 7; column <= headers.length; column += 1) {
        sheet.getColumn(column).numFmt = column === headers.length - 2 ? '0.0%' : '#,##0';
    }
    sheet.views = [{ state: 'frozen', xSplit: 8, ySplit: 5 }];
    sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: lastRow, column: headers.length } };
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(headers.length).letter}${lastRow}`;
};

export const buildProductionWorkbook = async ({ detail }: { detail: any }) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    workbook.company = COMPANY_NAME;
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;

    addDailyReportSheet(workbook, detail);
    addEntryLedgerSheet(workbook, detail);

    return workbook;
};
