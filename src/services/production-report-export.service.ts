import ExcelJS from 'exceljs';

const COLORS = {
    ink: 'FF17211B',
    muted: 'FF66736B',
    primary: 'FF147A4B',
    primarySoft: 'FFE8F4ED',
    navy: 'FF243B53',
    border: 'FFDCE4DE',
    warning: 'FFC87816',
    warningSoft: 'FFFFF4E5',
    danger: 'FFB42318',
    dangerSoft: 'FFFEECEB',
    white: 'FFFFFFFF',
    canvas: 'FFF6F8F7',
};

const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } },
};

const formatDate = (value: string) => {
    const [year, month, day] = String(value).split('-');
    return `${day}/${month}/${year}`;
};

const statusLabel = (status: string) =>
    ({ draft: 'Đang nhập', submitted: 'Chờ duyệt', locked: 'Đã khóa sổ' })[status] || status;

const severityLabel = (severity: string) =>
    ({ critical: 'Nghiêm trọng', warning: 'Cần chú ý', info: 'Thông tin' })[severity] || severity;

const typeLabel = (type: string) =>
    ({
        missing_report: 'Thiếu báo',
        under_target: 'Hụt khoán',
        zero_without_note: 'Sản lượng 0',
        unconfigured_line: 'Thiếu cấu hình',
        open_day: 'Chưa khóa sổ',
    })[type] || type;

const setupSheet = (sheet: ExcelJS.Worksheet, orientation: 'portrait' | 'landscape' = 'landscape') => {
    sheet.views = [{ state: 'frozen', ySplit: 6, showGridLines: false }];
    sheet.pageSetup = {
        paperSize: 9,
        orientation,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
    };
    sheet.headerFooter.oddFooter = 'Hải Đăng Production  |  Trang &P / &N';
    sheet.properties.defaultRowHeight = 19;
};

const addTitle = (sheet: ExcelJS.Worksheet, title: string, subtitle: string, lastColumn: number) => {
    sheet.mergeCells(1, 1, 1, lastColumn);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: COLORS.white } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primary } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(1).height = 30;

    sheet.mergeCells(2, 1, 2, lastColumn);
    const subtitleCell = sheet.getCell(2, 1);
    subtitleCell.value = subtitle;
    subtitleCell.font = { name: 'Arial', size: 10, color: { argb: COLORS.muted } };
    subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(2).height = 22;
};

const styleHeader = (row: ExcelJS.Row) => {
    row.height = 27;
    row.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.white } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = thinBorder;
    });
};

const styleRows = (sheet: ExcelJS.Worksheet, fromRow: number, toRow: number, toColumn: number) => {
    for (let rowIndex = fromRow; rowIndex <= toRow; rowIndex += 1) {
        const row = sheet.getRow(rowIndex);
        if (rowIndex % 2 === 0) {
            row.eachCell((cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.canvas } };
            });
        }
        for (let column = 1; column <= toColumn; column += 1) {
            const cell = row.getCell(column);
            cell.font = { name: 'Arial', size: 9, color: { argb: COLORS.ink } };
            cell.alignment = { vertical: 'middle', wrapText: true };
            cell.border = thinBorder;
        }
    }
};

const addOverviewSheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Tổng quan');
    setupSheet(sheet, 'landscape');
    addTitle(
        sheet,
        'BÁO CÁO QUẢN TRỊ SẢN XUẤT',
        `${report.meta.plantName || 'Cơ sở'}  |  ${formatDate(report.meta.from)} - ${formatDate(report.meta.to)}  |  ${
            report.meta.scope === 'locked' ? 'Chỉ số liệu đã khóa sổ' : 'Bao gồm số liệu đang vận hành'
        }`,
        10
    );

    const summary = report.summary;
    const metrics = [
        ['Số ngày có dữ liệu', summary.dayCount, 'Sản lượng thực tế', summary.actualQuantity],
        ['Ngày đã khóa sổ', summary.statusCounts.locked, 'Sản lượng mục tiêu', summary.targetQuantity],
        ['Tỷ lệ đạt', summary.achievementPercent / 100, 'Tỷ lệ báo đủ', summary.reportingRate / 100],
        ['Nhân sự bình quân', summary.averageWorkers, 'SP/người-ngày', summary.outputPerWorkerDay],
        ['Kế hoạch phát hành', summary.plannedQuantity, 'Thực hiện theo kế hoạch', summary.planAttainmentPercent / 100],
    ];
    metrics.forEach((values, index) => {
        const row = sheet.getRow(3 + index);
        row.values = values;
        [1, 3].forEach((column) => {
            row.getCell(column).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.muted } };
            row.getCell(column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
        });
        [2, 4].forEach((column) => {
            row.getCell(column).font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.ink } };
        });
        for (let column = 1; column <= 4; column += 1) row.getCell(column).border = thinBorder;
    });
    sheet.getCell(5, 2).numFmt = '0.0%';
    sheet.getCell(5, 4).numFmt = '0.0%';
    sheet.getCell(7, 4).numFmt = '0.0%';

    if (report.meta.financialsVisible) {
        sheet.getCell(3, 6).value = 'Giá trị sản lượng';
        sheet.getCell(3, 7).value = summary.totalAmount || 0;
        sheet.getCell(3, 6).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.muted } };
        sheet.getCell(3, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
        sheet.getCell(3, 7).font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.ink } };
        sheet.getCell(3, 7).numFmt = '#,##0 "đ"';
        sheet.getCell(3, 6).border = thinBorder;
        sheet.getCell(3, 7).border = thinBorder;
    }

    const headerRow = 10;
    sheet.getRow(headerRow).values = [
        'Ngày',
        'Trạng thái',
        'Mục tiêu',
        'Thực tế',
        '% đạt',
        'Kế hoạch',
        '% theo KH',
        'Báo đủ',
        'Nhân sự',
        ...(report.meta.financialsVisible ? ['Giá trị'] : []),
    ];
    styleHeader(sheet.getRow(headerRow));
    report.trend.forEach((day: any) => {
        sheet.addRow([
            formatDate(day.productionDate),
            statusLabel(day.status),
            day.targetQuantity,
            day.actualQuantity,
            day.achievementPercent / 100,
            day.plannedQuantity,
            day.planAttainmentPercent / 100,
            day.reportingRate / 100,
            day.workers,
            ...(report.meta.financialsVisible ? [day.totalAmount || 0] : []),
        ]);
    });
    const lastRow = Math.max(headerRow, sheet.rowCount);
    styleRows(sheet, headerRow + 1, lastRow, report.meta.financialsVisible ? 10 : 9);
    for (let row = headerRow + 1; row <= lastRow; row += 1) {
        sheet.getCell(row, 5).numFmt = '0.0%';
        sheet.getCell(row, 7).numFmt = '0.0%';
        sheet.getCell(row, 8).numFmt = '0.0%';
        if (report.meta.financialsVisible) sheet.getCell(row, 10).numFmt = '#,##0 "đ"';
    }
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: lastRow, column: report.meta.financialsVisible ? 10 : 9 },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }];
    sheet.columns = [
        { width: 13 },
        { width: 15 },
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 14 },
        { width: 11 },
        { width: 11 },
        { width: 11 },
        { width: 17 },
    ];
};

const addLineSheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Theo chuyền');
    setupSheet(sheet, 'landscape');
    const headers = [
        'STT',
        'Chuyền',
        'Tổ trưởng',
        'Ngày chạy',
        'NS bình quân',
        'Mục tiêu',
        'Thực tế',
        '% đạt',
        '% báo đủ',
        'SP/người-ngày',
        'Ngày hụt khoán',
        ...(report.meta.financialsVisible ? ['Giá trị'] : []),
    ];
    addTitle(
        sheet,
        'HIỆU SUẤT THEO CHUYỀN',
        `${report.meta.plantName}  |  ${formatDate(report.meta.from)} - ${formatDate(report.meta.to)}`,
        headers.length
    );
    const headerRow = 5;
    sheet.getRow(headerRow).values = headers;
    styleHeader(sheet.getRow(headerRow));
    report.lines.forEach((line: any, index: number) => {
        sheet.addRow([
            index + 1,
            line.lineName ? `${line.lineCode} - ${line.lineName}` : line.lineCode,
            line.leaderName || '',
            line.activeDays,
            line.averageWorkers,
            line.targetQuantity,
            line.actualQuantity,
            line.achievementPercent / 100,
            line.reportingRate / 100,
            line.outputPerWorkerDay,
            line.underTargetDays,
            ...(report.meta.financialsVisible ? [line.totalAmount || 0] : []),
        ]);
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
        sheet.getCell(row, 8).numFmt = '0.0%';
        sheet.getCell(row, 9).numFmt = '0.0%';
        if (report.meta.financialsVisible) sheet.getCell(row, 12).numFmt = '#,##0 "đ"';
    }
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: Math.max(headerRow, sheet.rowCount), column: headers.length },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 2, showGridLines: false }];
    sheet.columns = [
        { width: 7 },
        { width: 24 },
        { width: 20 },
        { width: 11 },
        { width: 13 },
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 11 },
        { width: 15 },
        { width: 14 },
        { width: 17 },
    ];
};

const addItemSheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Theo mã hàng');
    setupSheet(sheet, 'landscape');
    const headers = [
        'STT',
        'Mã hàng',
        'Tên hàng',
        'ĐVT',
        'Ngày chạy',
        'Số chuyền',
        'Mục tiêu',
        'Thực tế',
        '% đạt',
        'KH phát hành',
        '% theo KH',
        ...(report.meta.financialsVisible ? ['Giá trị'] : []),
    ];
    addTitle(
        sheet,
        'SẢN LƯỢNG THEO MÃ HÀNG',
        `${report.meta.plantName}  |  ${formatDate(report.meta.from)} - ${formatDate(report.meta.to)}`,
        headers.length
    );
    const headerRow = 5;
    sheet.getRow(headerRow).values = headers;
    styleHeader(sheet.getRow(headerRow));
    report.items.forEach((item: any, index: number) => {
        sheet.addRow([
            index + 1,
            item.itemCode,
            item.itemName || '',
            item.unit,
            item.activeDays,
            item.lineCount,
            item.targetQuantity,
            item.actualQuantity,
            item.achievementPercent / 100,
            item.plannedQuantity,
            item.planAttainmentPercent / 100,
            ...(report.meta.financialsVisible ? [item.totalAmount || 0] : []),
        ]);
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
        sheet.getCell(row, 9).numFmt = '0.0%';
        sheet.getCell(row, 11).numFmt = '0.0%';
        if (report.meta.financialsVisible) sheet.getCell(row, 12).numFmt = '#,##0 "đ"';
    }
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: Math.max(headerRow, sheet.rowCount), column: headers.length },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 3, showGridLines: false }];
    sheet.columns = [
        { width: 7 },
        { width: 18 },
        { width: 28 },
        { width: 9 },
        { width: 11 },
        { width: 11 },
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 14 },
        { width: 11 },
        { width: 17 },
    ];
};

const addExceptionSheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Ngoại lệ');
    setupSheet(sheet, 'landscape');
    const headers = ['STT', 'Ngày', 'Mức độ', 'Loại', 'Chuyền', 'Khung giờ', 'Nội dung', 'Chi tiết'];
    addTitle(
        sheet,
        'DANH SÁCH NGOẠI LỆ CẦN XỬ LÝ',
        `${report.exceptionSummary.total} ngoại lệ trong kỳ báo cáo`,
        headers.length
    );
    const headerRow = 5;
    sheet.getRow(headerRow).values = headers;
    styleHeader(sheet.getRow(headerRow));
    report.exceptions.forEach((item: any, index: number) => {
        const row = sheet.addRow([
            index + 1,
            formatDate(item.productionDate),
            severityLabel(item.severity),
            typeLabel(item.type),
            item.lineCode || '',
            item.slotLabel || '',
            item.title,
            item.description,
        ]);
        if (item.severity === 'critical') {
            row.getCell(3).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.danger } };
            row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.dangerSoft } };
        } else if (item.severity === 'warning') {
            row.getCell(3).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.warning } };
            row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warningSoft } };
        }
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: Math.max(headerRow, sheet.rowCount), column: headers.length },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }];
    sheet.columns = [
        { width: 7 },
        { width: 13 },
        { width: 14 },
        { width: 16 },
        { width: 12 },
        { width: 13 },
        { width: 30 },
        { width: 42 },
    ];
};

export const buildProductionReportWorkbook = async (report: any) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    workbook.company = 'Công ty TNHH May Xuất Khẩu Hải Đăng';
    workbook.created = new Date();
    workbook.modified = new Date();
    addOverviewSheet(workbook, report);
    addLineSheet(workbook, report);
    addItemSheet(workbook, report);
    addExceptionSheet(workbook, report);
    return workbook;
};
