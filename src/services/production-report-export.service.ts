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
        ['Sản lượng chuyển tiếp', summary.carryInQuantity || 0, 'Sản lượng trong kỳ', summary.periodQuantity ?? summary.actualQuantity],
        ['Ghi nhận trên hệ thống', summary.trackedToDateQuantity || 0, 'Lũy kế đến cuối kỳ', summary.cumulativeQuantity || 0],
        ['Sản lượng mục tiêu kỳ', summary.targetQuantity, 'Tỷ lệ đạt kỳ', summary.achievementPercent / 100],
        ['Số ngày có dữ liệu', summary.dayCount, 'Tỷ lệ báo đủ', summary.reportingRate / 100],
        ['Nhân sự bình quân', summary.averageWorkers, 'SP/người-ngày', summary.outputPerWorkerDay],
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
    sheet.getCell(5, 4).numFmt = '0.0%';
    sheet.getCell(6, 4).numFmt = '0.0%';

    if (report.meta.financialsVisible) {
        sheet.getCell(3, 6).value = 'Giá trị trong kỳ';
        sheet.getCell(3, 7).value = summary.periodAmount ?? summary.totalAmount ?? 0;
        sheet.getCell(3, 6).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.muted } };
        sheet.getCell(3, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
        sheet.getCell(3, 7).font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.ink } };
        sheet.getCell(3, 7).numFmt = '#,##0 "đ"';
        sheet.getCell(3, 6).border = thinBorder;
        sheet.getCell(3, 7).border = thinBorder;
        sheet.getCell(4, 6).value = 'Giá trị lũy kế';
        sheet.getCell(4, 7).value = summary.cumulativeAmount || 0;
        sheet.getCell(4, 6).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.muted } };
        sheet.getCell(4, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
        sheet.getCell(4, 7).font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.ink } };
        sheet.getCell(4, 7).numFmt = '#,##0 "đ"';
        sheet.getCell(4, 6).border = thinBorder;
        sheet.getCell(4, 7).border = thinBorder;
    }

    const headerRow = 10;
    sheet.getRow(headerRow).values = [
        'Ngày',
        'Trạng thái',
        'Mục tiêu',
        'Trong kỳ',
        'Lũy kế',
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
            day.periodQuantity ?? day.actualQuantity,
            day.cumulativeQuantity || 0,
            day.achievementPercent / 100,
            day.plannedQuantity,
            day.planAttainmentPercent / 100,
            day.reportingRate / 100,
            day.workers,
            ...(report.meta.financialsVisible ? [day.totalAmount || 0] : []),
        ]);
    });
    const lastRow = Math.max(headerRow, sheet.rowCount);
    styleRows(sheet, headerRow + 1, lastRow, report.meta.financialsVisible ? 11 : 10);
    for (let row = headerRow + 1; row <= lastRow; row += 1) {
        sheet.getCell(row, 6).numFmt = '0.0%';
        sheet.getCell(row, 8).numFmt = '0.0%';
        sheet.getCell(row, 9).numFmt = '0.0%';
        if (report.meta.financialsVisible) sheet.getCell(row, 11).numFmt = '#,##0 "đ"';
    }
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: lastRow, column: report.meta.financialsVisible ? 11 : 10 },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }];
    sheet.columns = [
        { width: 13 },
        { width: 15 },
        { width: 14 },
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
        'Trước kỳ',
        'Trong kỳ',
        'Lũy kế',
        'Mục tiêu kỳ',
        '% đạt kỳ',
        '% báo đủ',
        'SP/người-ngày',
        'Ngày hụt khoán',
        'Đầu kỳ chưa phân bổ',
        ...(report.meta.financialsVisible ? ['Giá trị lũy kế'] : []),
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
            line.openingQuantity || 0,
            line.periodQuantity ?? line.actualQuantity,
            line.cumulativeQuantity ?? line.actualQuantity,
            line.targetQuantity,
            line.achievementPercent / 100,
            line.reportingRate / 100,
            line.outputPerWorkerDay,
            line.underTargetDays,
            line.unallocatedOpeningQuantity || 0,
            ...(report.meta.financialsVisible ? [line.cumulativeAmount ?? line.totalAmount ?? 0] : []),
        ]);
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
        sheet.getCell(row, 10).numFmt = '0.0%';
        sheet.getCell(row, 11).numFmt = '0.0%';
        if (report.meta.financialsVisible) sheet.getCell(row, 15).numFmt = '#,##0 "đ"';
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
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 11 },
        { width: 15 },
        { width: 14 },
        { width: 18 },
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
        'Trước kỳ',
        'Trong kỳ',
        'Lũy kế',
        'Mục tiêu kỳ',
        '% đạt kỳ',
        'KH phát hành',
        '% theo KH',
        ...(report.meta.financialsVisible ? ['Giá trị lũy kế'] : []),
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
            item.openingQuantity || 0,
            item.periodQuantity ?? item.actualQuantity,
            item.cumulativeQuantity ?? item.actualQuantity,
            item.targetQuantity,
            item.achievementPercent / 100,
            item.plannedQuantity,
            item.planAttainmentPercent / 100,
            ...(report.meta.financialsVisible ? [item.cumulativeAmount ?? item.totalAmount ?? 0] : []),
        ]);
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
        sheet.getCell(row, 11).numFmt = '0.0%';
        sheet.getCell(row, 13).numFmt = '0.0%';
        if (report.meta.financialsVisible) sheet.getCell(row, 14).numFmt = '#,##0 "đ"';
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
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 14 },
        { width: 11 },
        { width: 17 },
    ];
};

const addOrderSheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Theo đơn hàng');
    setupSheet(sheet, 'landscape');
    const headers = [
        'STT',
        'Mã đơn hàng',
        'Mã hàng',
        'Số chuyền',
        'Trước kỳ',
        'Trong kỳ',
        'Lũy kế',
        'Mục tiêu kỳ',
        '% đạt kỳ',
        'KH phát hành',
        '% theo KH',
        ...(report.meta.financialsVisible ? ['Giá trị lũy kế', 'Tình trạng đơn giá'] : []),
    ];
    addTitle(
        sheet,
        'SẢN LƯỢNG THEO ĐƠN HÀNG',
        `${report.meta.plantName}  |  ${formatDate(report.meta.from)} - ${formatDate(report.meta.to)}`,
        headers.length
    );
    const headerRow = 5;
    sheet.getRow(headerRow).values = headers;
    styleHeader(sheet.getRow(headerRow));
    (report.orders || []).forEach((order: any, index: number) => {
        sheet.addRow([
            index + 1,
            order.orderCode || 'Chưa gán đơn hàng',
            (order.itemCodes || []).join(', '),
            order.lineCount,
            order.openingQuantity || 0,
            order.periodQuantity ?? order.actualQuantity ?? 0,
            order.cumulativeQuantity ?? order.actualQuantity ?? 0,
            order.targetQuantity || 0,
            Number(order.achievementPercent || 0) / 100,
            order.plannedQuantity || 0,
            Number(order.planAttainmentPercent || 0) / 100,
            ...(report.meta.financialsVisible
                ? [
                      order.cumulativeAmount ?? order.totalAmount ?? 0,
                      order.openingAmountComplete ? 'Đủ đơn giá' : 'Thiếu đơn giá đầu kỳ',
                  ]
                : []),
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
    sheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 2, showGridLines: false }];
    sheet.columns = [
        { width: 7 },
        { width: 24 },
        { width: 28 },
        { width: 11 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 14 },
        { width: 11 },
        { width: 18 },
        { width: 22 },
    ];
};

const addDailySheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Theo ngày');
    setupSheet(sheet, 'landscape');
    const headers = [
        'STT',
        'Ngày',
        'Trạng thái',
        'Mục tiêu',
        'Trong ngày',
        'Lũy kế',
        '% đạt',
        'KH phát hành',
        '% theo KH',
        '% báo đủ',
        'Nhân sự',
        ...(report.meta.financialsVisible ? ['Giá trị trong ngày', 'Giá trị lũy kế'] : []),
    ];
    addTitle(
        sheet,
        'DIỄN BIẾN SẢN LƯỢNG THEO NGÀY',
        `${report.meta.plantName}  |  ${formatDate(report.meta.from)} - ${formatDate(report.meta.to)}`,
        headers.length
    );
    const headerRow = 5;
    sheet.getRow(headerRow).values = headers;
    styleHeader(sheet.getRow(headerRow));
    report.trend.forEach((day: any, index: number) => {
        sheet.addRow([
            index + 1,
            formatDate(day.productionDate),
            statusLabel(day.status),
            day.targetQuantity,
            day.periodQuantity ?? day.actualQuantity,
            day.cumulativeQuantity || 0,
            Number(day.achievementPercent || 0) / 100,
            day.plannedQuantity,
            Number(day.planAttainmentPercent || 0) / 100,
            Number(day.reportingRate || 0) / 100,
            day.workers,
            ...(report.meta.financialsVisible
                ? [day.totalAmount || 0, day.cumulativeAmount || 0]
                : []),
        ]);
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
        sheet.getCell(row, 7).numFmt = '0.0%';
        sheet.getCell(row, 9).numFmt = '0.0%';
        sheet.getCell(row, 10).numFmt = '0.0%';
        if (report.meta.financialsVisible) {
            sheet.getCell(row, 12).numFmt = '#,##0 "đ"';
            sheet.getCell(row, 13).numFmt = '#,##0 "đ"';
        }
    }
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: Math.max(headerRow, sheet.rowCount), column: headers.length },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 2, showGridLines: false }];
    sheet.columns = [
        { width: 7 },
        { width: 13 },
        { width: 15 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 10 },
        { width: 14 },
        { width: 11 },
        { width: 11 },
        { width: 11 },
        { width: 18 },
        { width: 18 },
    ];
};

const addReconciliationSheet = (workbook: ExcelJS.Workbook, report: any) => {
    const sheet = workbook.addWorksheet('Đối soát đầu kỳ');
    setupSheet(sheet, 'landscape');
    const coverage = report.meta.dataCoverage || {};
    addTitle(
        sheet,
        'ĐỐI SOÁT SẢN LƯỢNG ĐẦU KỲ VÀ LŨY KẾ',
        `${report.meta.plantName}  |  Dữ liệu tạo lúc ${new Date(report.meta.generatedAt || Date.now()).toLocaleString('vi-VN')}`,
        8
    );
    const summary = report.summary;
    const overview = [
        ['Ngày chốt đầu kỳ', coverage.cutoffDate ? formatDate(coverage.cutoffDate) : 'Chưa khai báo'],
        ['Ngày bắt đầu dữ liệu giờ', coverage.trackingStartDate ? formatDate(coverage.trackingStartDate) : 'Chưa xác định'],
        ['Sản lượng chuyển tiếp', summary.carryInQuantity || 0],
        ['Sản lượng hệ thống đến cuối kỳ', summary.trackedToDateQuantity || 0],
        ['Lũy kế toàn bộ', { formula: 'B5+B6', result: summary.cumulativeQuantity || 0 }],
        ['Sản lượng chưa phân bổ', summary.unallocatedOpeningQuantity || 0],
        ['Mức phủ đơn giá đầu kỳ', Number(coverage.amountCoveragePercent ?? 100) / 100],
    ];
    overview.forEach((values, index) => {
        const row = sheet.getRow(3 + index);
        row.values = values;
        row.getCell(1).font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.muted } };
        row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
        row.getCell(2).font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.ink } };
        row.getCell(1).border = thinBorder;
        row.getCell(2).border = thinBorder;
    });
    sheet.getCell(9, 2).numFmt = '0.0%';

    const headerRow = 12;
    const headers = ['STT', 'Chuyền', 'Trước kỳ', 'Trong kỳ', 'Lũy kế báo cáo', 'Đối soát công thức', 'Chênh lệch', 'Chưa phân bổ'];
    sheet.getRow(headerRow).values = headers;
    styleHeader(sheet.getRow(headerRow));
    report.lines.forEach((line: any, index: number) => {
        const rowNumber = headerRow + index + 1;
        sheet.addRow([
            index + 1,
            line.lineName ? `${line.lineCode} - ${line.lineName}` : line.lineCode,
            line.openingQuantity || 0,
            line.periodQuantity ?? line.actualQuantity ?? 0,
            line.cumulativeQuantity ?? line.actualQuantity ?? 0,
            { formula: `C${rowNumber}+D${rowNumber}`, result: line.cumulativeQuantity ?? line.actualQuantity ?? 0 },
            { formula: `E${rowNumber}-F${rowNumber}`, result: 0 },
            line.unallocatedOpeningQuantity || 0,
        ]);
    });
    styleRows(sheet, headerRow + 1, sheet.rowCount, headers.length);
    for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
        const difference = sheet.getCell(row, 7);
        difference.numFmt = '#,##0;[Red]-#,##0';
    }
    sheet.autoFilter = {
        from: { row: headerRow, column: 1 },
        to: { row: Math.max(headerRow, sheet.rowCount), column: headers.length },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 2, showGridLines: false }];
    sheet.columns = [
        { width: 7 },
        { width: 26 },
        { width: 16 },
        { width: 16 },
        { width: 18 },
        { width: 18 },
        { width: 14 },
        { width: 18 },
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
    addOrderSheet(workbook, report);
    addDailySheet(workbook, report);
    addReconciliationSheet(workbook, report);
    addExceptionSheet(workbook, report);
    return workbook;
};
