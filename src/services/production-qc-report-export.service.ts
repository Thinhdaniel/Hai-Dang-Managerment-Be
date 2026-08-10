import ExcelJS from 'exceljs';

const numberFormat = '#,##0';
const percentFormat = '0.00%';
const colors = {
    navy: 'FF17324D',
    blue: 'FF176B87',
    cyan: 'FF0E7490',
    green: 'FF16794B',
    red: 'FFB42318',
    amber: 'FFB54708',
    pale: 'FFEFF6F8',
    white: 'FFFFFFFF',
    line: 'FFD7E1E7',
};

const styleHeader = (row: ExcelJS.Row) => {
    row.height = 28;
    row.eachCell((cell) => {
        cell.font = { name: 'Arial', bold: true, color: { argb: colors.white } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.blue } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: colors.line } } };
    });
};

const title = (sheet: ExcelJS.Worksheet, text: string, subtitle: string, columns: number) => {
    sheet.mergeCells(1, 1, 1, columns);
    const heading = sheet.getCell(1, 1);
    heading.value = text;
    heading.font = { name: 'Arial', size: 16, bold: true, color: { argb: colors.navy } };
    heading.alignment = { vertical: 'middle' };
    sheet.getRow(1).height = 30;
    sheet.mergeCells(2, 1, 2, columns);
    const sub = sheet.getCell(2, 1);
    sub.value = subtitle;
    sub.font = { name: 'Arial', size: 10, color: { argb: 'FF52677A' } };
    sub.alignment = { vertical: 'middle' };
    sheet.getRow(2).height = 22;
};

const applyBody = (sheet: ExcelJS.Worksheet, startRow: number) => {
    for (let rowNumber = startRow; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        row.height = 22;
        row.eachCell((cell) => {
            cell.font = { name: 'Arial', size: 10, color: { argb: colors.navy } };
            cell.alignment = { vertical: 'middle', wrapText: true };
            cell.border = { bottom: { style: 'hair', color: { argb: colors.line } } };
        });
        if ((rowNumber - startRow) % 2 === 1) {
            row.eachCell((cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFB' } };
            });
        }
    }
};

const configurePrint = (sheet: ExcelJS.Worksheet, lastColumn: string, orientation: 'portrait' | 'landscape') => {
    sheet.pageSetup.paperSize = 9;
    sheet.pageSetup.orientation = orientation;
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    sheet.pageSetup.fitToHeight = orientation === 'portrait' ? 1 : 0;
    sheet.pageSetup.horizontalCentered = true;
    sheet.pageSetup.margins = {
        left: 0.28,
        right: 0.28,
        top: 0.45,
        bottom: 0.45,
        header: 0.2,
        footer: 0.2,
    };
    sheet.pageSetup.printTitlesRow = '1:4';
    sheet.pageSetup.printArea = `A1:${lastColumn}${Math.max(4, sheet.rowCount)}`;
    sheet.headerFooter.oddFooter = '&LHải Đăng Production&CĐối soát QC&RTrang &P / &N';
};

export const buildProductionQcReportWorkbook = async (report: any) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    workbook.company = 'Công ty TNHH May Xuất Khẩu Hải Đăng';
    workbook.created = new Date();
    const rangeLabel = `${report.meta.from} đến ${report.meta.to}`;

    const summary = workbook.addWorksheet('Tổng quan', {
        pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    });
    summary.columns = [
        { key: 'label', width: 34 },
        { key: 'value', width: 22 },
        { key: 'note', width: 46 },
    ];
    title(summary, 'BÁO CÁO ĐỐI SOÁT QC', `${report.meta.plantName || ''} · ${rangeLabel}`, 3);
    summary.addRow([]);
    summary.addRow(['Chỉ tiêu', 'Giá trị', 'Ghi chú']);
    styleHeader(summary.getRow(4));
    const pendingText = report.summary.pendingKnown
        ? Number(report.summary.pendingQuantity || 0)
        : 'Chưa đủ dữ liệu đầu kỳ';
    [
        ['Sản báo trong kỳ', report.summary.periodProduced, 'Sản lượng chuyền ghi nhận trong khoảng lọc'],
        ['QC lần đầu trong kỳ', report.summary.periodFirstPass, 'Không cộng tái kiểm'],
        ['Đạt trong kỳ', report.summary.periodPassed, 'Kết quả kiểm lần đầu'],
        ['Lỗi trong kỳ', report.summary.periodDefect, `Tỷ lệ ${report.summary.periodDefectRate}%`],
        ['Tái kiểm trong kỳ', report.summary.periodRecheck, 'Theo dõi riêng, không giảm tồn lần thứ hai'],
        ['Sản lũy kế', report.summary.cumulativeProduced, 'Gồm số đầu kỳ và số trên hệ thống'],
        ['QC lũy kế', report.summary.cumulativeInspected ?? 'Chưa xác định', 'Phụ thuộc số đầu kỳ QC'],
        ['Còn chờ QC', pendingText, 'Tồn đối soát đến cuối kỳ'],
        ['Tiến độ QC', report.summary.qcCompletionPercent ?? 'Chưa xác định', 'QC lũy kế / Sản lũy kế'],
        ['Ngoại lệ', report.summary.exceptionCount, 'Các điểm cần rà soát dữ liệu hoặc chất lượng'],
    ].forEach((row) => summary.addRow(row));
    applyBody(summary, 5);
    summary.getColumn(2).numFmt = numberFormat;
    summary.getCell(13, 2).numFmt = '0.00';
    summary.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
    configurePrint(summary, 'C', 'portrait');

    const items = workbook.addWorksheet('Theo mã hàng', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    items.columns = [
        { key: 'code', width: 18 },
        { key: 'name', width: 26 },
        { key: 'opening', width: 16 },
        { key: 'produced', width: 16 },
        { key: 'firstPass', width: 16 },
        { key: 'passed', width: 14 },
        { key: 'defect', width: 14 },
        { key: 'pending', width: 16 },
        { key: 'completion', width: 15 },
        { key: 'defectRate', width: 14 },
        { key: 'recheck', width: 14 },
        { key: 'lastQc', width: 16 },
    ];
    title(items, 'ĐỐI SOÁT THEO MÃ HÀNG', `${report.meta.plantName || ''} · ${rangeLabel}`, 12);
    items.addRow([]);
    items.addRow([
        'Mã hàng',
        'Tên hàng',
        'Tồn QC đầu kỳ',
        'Sản trong kỳ',
        'QC lần đầu',
        'Đạt',
        'Lỗi',
        'Còn chờ',
        'Tiến độ QC',
        'Tỷ lệ lỗi',
        'Tái kiểm',
        'QC gần nhất',
    ]);
    styleHeader(items.getRow(4));
    report.items.forEach((row: any) =>
        items.addRow([
            row.itemCode,
            row.itemName || '',
            row.openingPending,
            row.periodProduced,
            row.periodFirstPass,
            row.periodPassed,
            row.periodDefect,
            row.pendingQuantity ?? 'Chưa xác định',
            row.qcCompletionPercent === undefined ? '' : row.qcCompletionPercent / 100,
            row.periodDefectRate / 100,
            row.periodRecheck,
            row.lastQcDate || '',
        ])
    );
    applyBody(items, 5);
    [3, 4, 5, 6, 7, 8, 11].forEach((column) => (items.getColumn(column).numFmt = numberFormat));
    items.getColumn(9).numFmt = percentFormat;
    items.getColumn(10).numFmt = percentFormat;
    items.autoFilter = { from: 'A4', to: 'L4' };
    items.views = [{ state: 'frozen', ySplit: 4, xSplit: 2, showGridLines: false }];
    configurePrint(items, 'L', 'landscape');

    const lines = workbook.addWorksheet('Theo chuyền');
    lines.columns = [
        { key: 'code', width: 16 },
        { key: 'name', width: 24 },
        { key: 'opening', width: 16 },
        { key: 'produced', width: 16 },
        { key: 'firstPass', width: 16 },
        { key: 'passed', width: 14 },
        { key: 'defect', width: 14 },
        { key: 'pending', width: 16 },
        { key: 'completion', width: 15 },
        { key: 'defectRate', width: 14 },
        { key: 'recheck', width: 14 },
        { key: 'lastQc', width: 16 },
    ];
    title(lines, 'ĐỐI SOÁT THEO CHUYỀN', `${report.meta.plantName || ''} · ${rangeLabel}`, 12);
    lines.addRow([]);
    lines.addRow([
        'Mã chuyền',
        'Tên chuyền',
        'Tồn QC đầu kỳ',
        'Sản trong kỳ',
        'QC lần đầu',
        'Đạt',
        'Lỗi',
        'Còn chờ',
        'Tiến độ QC',
        'Tỷ lệ lỗi',
        'Tái kiểm',
        'QC gần nhất',
    ]);
    styleHeader(lines.getRow(4));
    report.lines.forEach((row: any) =>
        lines.addRow([
            row.lineCode,
            row.lineName || '',
            row.openingPending,
            row.periodProduced,
            row.periodFirstPass,
            row.periodPassed,
            row.periodDefect,
            row.pendingQuantity ?? 'Chưa xác định',
            row.qcCompletionPercent === undefined ? '' : row.qcCompletionPercent / 100,
            row.periodDefectRate / 100,
            row.periodRecheck,
            row.lastQcDate || '',
        ])
    );
    applyBody(lines, 5);
    [3, 4, 5, 6, 7, 8, 11].forEach((column) => (lines.getColumn(column).numFmt = numberFormat));
    lines.getColumn(9).numFmt = percentFormat;
    lines.getColumn(10).numFmt = percentFormat;
    lines.autoFilter = { from: 'A4', to: 'L4' };
    lines.views = [{ state: 'frozen', ySplit: 4, xSplit: 2, showGridLines: false }];
    configurePrint(lines, 'L', 'landscape');

    const daily = workbook.addWorksheet('Theo ngày');
    daily.columns = [
        { key: 'date', width: 16 },
        { key: 'produced', width: 16 },
        { key: 'firstPass', width: 16 },
        { key: 'passed', width: 14 },
        { key: 'defect', width: 14 },
        { key: 'rate', width: 14 },
        { key: 'recheck', width: 14 },
        { key: 'cumulative', width: 18 },
        { key: 'pending', width: 18 },
    ];
    title(daily, 'DIỄN BIẾN QC THEO NGÀY', `${report.meta.plantName || ''} · ${rangeLabel}`, 9);
    daily.addRow([]);
    daily.addRow(['Ngày', 'Sản báo', 'QC lần đầu', 'Đạt', 'Lỗi', 'Tỷ lệ lỗi', 'Tái kiểm', 'Sản lũy kế', 'Còn chờ']);
    styleHeader(daily.getRow(4));
    report.trend.forEach((row: any) =>
        daily.addRow([
            row.date,
            row.produced,
            row.firstPass,
            row.passed,
            row.defect,
            row.defectRate / 100,
            row.recheck,
            row.cumulativeProduced,
            row.cumulativePending ?? 'Chưa xác định',
        ])
    );
    applyBody(daily, 5);
    [2, 3, 4, 5, 7, 8, 9].forEach((column) => (daily.getColumn(column).numFmt = numberFormat));
    daily.getColumn(6).numFmt = percentFormat;
    daily.autoFilter = { from: 'A4', to: 'I4' };
    daily.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
    configurePrint(daily, 'I', 'landscape');

    const exceptions = workbook.addWorksheet('Bất thường');
    exceptions.columns = [
        { key: 'severity', width: 16 },
        { key: 'item', width: 18 },
        { key: 'title', width: 34 },
        { key: 'description', width: 70 },
        { key: 'quantity', width: 18 },
    ];
    title(exceptions, 'DANH SÁCH CẦN RÀ SOÁT', `${report.meta.plantName || ''} · ${rangeLabel}`, 5);
    exceptions.addRow([]);
    exceptions.addRow(['Mức độ', 'Mã hàng', 'Nội dung', 'Chi tiết', 'Số lượng']);
    styleHeader(exceptions.getRow(4));
    report.exceptions.forEach((row: any) =>
        exceptions.addRow([
            row.severity === 'critical' ? 'Nghiêm trọng' : 'Cảnh báo',
            row.itemCode || '',
            row.title,
            row.description,
            row.quantity || '',
        ])
    );
    applyBody(exceptions, 5);
    exceptions.getColumn(5).numFmt = numberFormat;
    exceptions.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
    configurePrint(exceptions, 'E', 'landscape');

    return workbook;
};
