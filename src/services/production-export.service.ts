import ExcelJS from 'exceljs';

const COLORS = {
    ink: 'FF17211B',
    muted: 'FF66736B',
    primary: 'FF147A4B',
    primaryDark: 'FF0E5D39',
    primarySoft: 'FFE8F4ED',
    border: 'FFD8E2DB',
    white: 'FFFFFFFF',
    warning: 'FFFFF3D8',
    danger: 'FFFDE8E8',
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
    companyCell.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
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
    styleTitle(
        sheet,
        8,
        'BÁO CÁO SẢN LƯỢNG NGÀY',
        `${detail.plantName || 'Cơ sở'} · Ngày ${formatProductionDate(detail.productionDate)}`
    );
    sheet.mergeCells('A5:H5');
    sheet.getCell('A5').value = `Trạng thái: ${statusLabel(detail.status)} · Cập nhật: ${new Date(
        detail.updatedAt || Date.now()
    ).toLocaleString('vi-VN')}`;
    sheet.getCell('A5').font = { size: 10, color: { argb: COLORS.muted } };
    sheet.getCell('A5').alignment = { horizontal: 'center' };

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
    const headerRow = sheet.getRow(7);
    headerRow.values = headers;
    styleHeader(headerRow);

    detail.lines.forEach((line: any) => {
        sheet.addRow([
            line.lineCode,
            line.leaderName || '',
            line.runs.length,
            line.totalTarget,
            line.totalActual,
            line.totalTarget > 0 ? line.totalActual / line.totalTarget : 0,
            line.totalAmount,
            line.averageIncome,
        ]);
    });
    const totalRow = sheet.addRow([
        'TỔNG',
        '',
        detail.summary.itemCount,
        detail.summary.totalTarget,
        detail.summary.totalActual,
        detail.summary.totalTarget > 0 ? detail.summary.totalActual / detail.summary.totalTarget : 0,
        detail.summary.totalAmount,
        detail.summary.averageIncome,
    ]);
    totalRow.font = { bold: true, color: { argb: COLORS.primaryDark } };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };

    styleDataArea(sheet, 8, totalRow.number, headers.length);
    sheet.getColumn(1).width = 14;
    sheet.getColumn(2).width = 22;
    sheet.getColumn(3).width = 14;
    sheet.getColumn(4).width = 18;
    sheet.getColumn(5).width = 18;
    sheet.getColumn(6).width = 12;
    sheet.getColumn(7).width = 20;
    sheet.getColumn(8).width = 21;
    sheet.getColumn(6).numFmt = '0.0%';
    [4, 5, 7, 8].forEach((column) => {
        sheet.getColumn(column).numFmt = '#,##0';
    });
    sheet.views = [{ state: 'frozen', ySplit: 7 }];
    sheet.autoFilter = { from: { row: 7, column: 1 }, to: { row: totalRow.number - 1, column: 8 } };
    sheet.pageSetup.printArea = `A1:H${totalRow.number}`;
};

const addPlanSheet = (workbook: ExcelJS.Workbook, detail: any, plan: any) => {
    if (!plan?.allocations?.length) return;
    const sheet = workbook.addWorksheet('KE HOACH NGAY');
    configureSheet(sheet, 'landscape');
    styleTitle(
        sheet,
        11,
        'KẾ HOẠCH SẢN XUẤT NGÀY',
        `${detail.plantName || 'Cơ sở'} · ${formatProductionDate(detail.productionDate)} · Phiên bản ${plan.revision}`
    );
    const header = sheet.getRow(5);
    header.values = [
        'STT',
        'Chuyền',
        'Mã hàng',
        'Mã đơn / LSX',
        'Mức ưu tiên',
        'Khung chạy',
        'Kế hoạch (SP)',
        'Khoán/giờ',
        'Thực tế (SP)',
        'Còn thiếu (SP)',
        'Nguồn',
    ];
    styleHeader(header);
    const lineById = new Map(detail.lines.map((line: any) => [String(line.lineId), line]));
    plan.allocations.forEach((allocation: any, index: number) => {
        const line: any = lineById.get(String(allocation.lineId));
        const runs = (line?.runs || []).filter(
            (run: any) => String(run.planAllocationId || '') === String(allocation.id)
        );
        const runIds = new Set(runs.map((run: any) => String(run.id)));
        const actual = (line?.entries || [])
            .filter((entry: any) => runIds.has(String(entry.runId)))
            .reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
        const row = sheet.addRow([
            index + 1,
            allocation.lineCode,
            allocation.itemCode,
            allocation.orderCode || '',
            ({ urgent: 'Khẩn', high: 'Cao', normal: 'Thường', low: 'Thấp' } as Record<string, string>)[
                allocation.priority
            ] || 'Thường',
            `${allocation.startSlotKey} - ${allocation.endSlotKey}`,
            allocation.plannedQuantity,
            allocation.hourlyQuota,
            actual,
            Math.max(0, Number(allocation.plannedQuantity || 0) - actual),
            allocation.sourceType === 'carry_over'
                ? `Chuyển từ ${formatProductionDate(allocation.sourceProductionDate || detail.productionDate)}`
                : 'Kế hoạch ngày',
        ]);
        if (actual < Number(allocation.plannedQuantity || 0)) {
            row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warning } };
        }
    });
    const totalRow = sheet.addRow([
        '',
        '',
        '',
        '',
        '',
        'TỔNG',
        { formula: `SUM(G6:G${sheet.rowCount})` },
        '',
        { formula: `SUM(I6:I${sheet.rowCount})` },
        { formula: `SUM(J6:J${sheet.rowCount})` },
        '',
    ]);
    totalRow.font = { bold: true, color: { argb: COLORS.primaryDark } };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
    styleDataArea(sheet, 6, totalRow.number, 11);
    sheet.columns = [
        { width: 6 },
        { width: 12 },
        { width: 16 },
        { width: 18 },
        { width: 12 },
        { width: 16 },
        { width: 17 },
        { width: 14 },
        { width: 16 },
        { width: 17 },
        { width: 20 },
    ];
    [7, 8, 9, 10].forEach((column) => (sheet.getColumn(column).numFmt = '#,##0'));
    sheet.views = [{ state: 'frozen', ySplit: 5 }];
    sheet.autoFilter = { from: 'A5', to: `K${Math.max(6, totalRow.number - 1)}` };
    sheet.pageSetup.printArea = `A1:K${totalRow.number}`;
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
        ...activeSlots.map((slot: any) => slot.label),
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

const monthDateKeys = (monthKey: string) => {
    const [year, month] = monthKey.split('-').map(Number);
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({ length: count }, (_, index) => `${monthKey}-${String(index + 1).padStart(2, '0')}`);
};

const addMonthlySummarySheet = (workbook: ExcelJS.Workbook, selectedDetail: any, monthDetails: any[]) => {
    const lineCodes = [
        ...new Set(
            monthDetails
                .flatMap((detail) => detail.lines)
                .sort((left: any, right: any) => left.sortOrder - right.sortOrder)
                .map((line: any) => line.lineCode)
        ),
    ];
    const monthKey = selectedDetail.productionDate.slice(0, 7);
    const headers = ['Ngày', 'Trạng thái', ...lineCodes, 'Tổng ngày', 'Lũy kế'];
    const sheet = workbook.addWorksheet('TONG HOP THANG');
    configureSheet(sheet, 'landscape');
    styleTitle(
        sheet,
        headers.length,
        'TỔNG HỢP SẢN LƯỢNG THÁNG',
        `${selectedDetail.plantName || 'Cơ sở'} · Tháng ${monthKey.slice(5, 7)}/${monthKey.slice(0, 4)} · Trạng thái được ghi rõ từng ngày`
    );
    const headerRow = sheet.getRow(5);
    headerRow.values = headers;
    styleHeader(headerRow);

    const detailByDate = new Map(monthDetails.map((detail) => [detail.productionDate, detail]));
    let cumulative = 0;
    monthDateKeys(monthKey).forEach((dateKey) => {
        const detail: any = detailByDate.get(dateKey);
        const quantities = lineCodes.map(
            (code) => detail?.lines.find((line: any) => line.lineCode === code)?.totalActual || 0
        );
        const total = quantities.reduce((sum, value) => sum + Number(value || 0), 0);
        cumulative += total;
        sheet.addRow([
            formatProductionDate(dateKey).slice(0, 5),
            detail ? statusLabel(detail.status) : '',
            ...quantities,
            total,
            cumulative,
        ]);
    });
    const totalRow = sheet.addRow([
        'TỔNG',
        '',
        ...lineCodes.map((code) =>
            monthDetails.reduce(
                (sum, detail) =>
                    sum + Number(detail.lines.find((line: any) => line.lineCode === code)?.totalActual || 0),
                0
            )
        ),
        monthDetails.reduce((sum, detail) => sum + Number(detail.summary.totalActual || 0), 0),
        '',
    ]);
    totalRow.font = { bold: true, color: { argb: COLORS.primaryDark } };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
    styleDataArea(sheet, 6, totalRow.number, headers.length);
    sheet.getColumn(1).width = 11;
    sheet.getColumn(2).width = 14;
    for (let column = 3; column <= headers.length; column += 1) sheet.getColumn(column).width = 12;
    sheet.getColumn(headers.length - 1).width = 15;
    sheet.getColumn(headers.length).width = 15;
    for (let column = 3; column <= headers.length; column += 1) sheet.getColumn(column).numFmt = '#,##0';
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 5 }];
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(headers.length).letter}${totalRow.number}`;
};

const addItemSummarySheet = (workbook: ExcelJS.Workbook, selectedDetail: any, monthDetails: any[]) => {
    const byItem = new Map<string, any>();
    monthDetails.forEach((detail) => {
        detail.lines.forEach((line: any) => {
            const runs = new Map(line.runs.map((run: any) => [run.id, run]));
            line.entries.forEach((entry: any) => {
                const run: any = runs.get(entry.runId);
                if (!run) return;
                const current = byItem.get(run.itemCode) || {
                    code: run.itemCode,
                    name: run.itemName || '',
                    unit: run.unit || 'SP',
                    quantity: 0,
                    amount: 0,
                    days: new Set<string>(),
                };
                current.quantity += Number(entry.quantity || 0);
                current.amount += Number(entry.amount || 0);
                current.days.add(detail.productionDate);
                byItem.set(run.itemCode, current);
            });
        });
    });

    const sheet = workbook.addWorksheet('TH MA HANG');
    configureSheet(sheet, 'portrait');
    styleTitle(
        sheet,
        7,
        'TỔNG HỢP THEO MÃ HÀNG',
        `${selectedDetail.plantName || 'Cơ sở'} · Tháng ${selectedDetail.productionDate.slice(5, 7)}/${selectedDetail.productionDate.slice(0, 4)} · Đối chiếu trạng thái tại sheet TONG HOP THANG`
    );
    const headers = ['Mã hàng', 'Tên hàng', 'Đơn vị', 'Số ngày chạy', 'SL thực tế', 'Đơn giá BQ (đ)', 'Thành tiền (đ)'];
    const headerRow = sheet.getRow(5);
    headerRow.values = headers;
    styleHeader(headerRow);
    [...byItem.values()]
        .sort((left, right) => right.amount - left.amount || left.code.localeCompare(right.code))
        .forEach((item) => {
            sheet.addRow([
                item.code,
                item.name,
                item.unit,
                item.days.size,
                item.quantity,
                item.quantity > 0 ? item.amount / item.quantity : 0,
                item.amount,
            ]);
        });
    const totalQuantity = [...byItem.values()].reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = [...byItem.values()].reduce((sum, item) => sum + item.amount, 0);
    const totalRow = sheet.addRow(['TỔNG', '', '', '', totalQuantity, '', totalAmount]);
    totalRow.font = { bold: true, color: { argb: COLORS.primaryDark } };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primarySoft } };
    styleDataArea(sheet, 6, totalRow.number, headers.length);
    sheet.columns = [
        { width: 16 },
        { width: 28 },
        { width: 11 },
        { width: 14 },
        { width: 17 },
        { width: 18 },
        { width: 20 },
    ];
    [4, 5, 6, 7].forEach((column) => (sheet.getColumn(column).numFmt = '#,##0'));
    sheet.views = [{ state: 'frozen', ySplit: 5 }];
    sheet.pageSetup.printArea = `A1:G${totalRow.number}`;
};

const addCatalogSheet = (workbook: ExcelJS.Workbook, detail: any, lines: any[], items: any[]) => {
    const sheet = workbook.addWorksheet('DANH MUC');
    configureSheet(sheet, 'portrait');
    styleTitle(sheet, 6, 'DANH MỤC SẢN XUẤT', detail.plantName || 'Cơ sở');
    const lineHeader = sheet.getRow(5);
    lineHeader.values = ['Mã chuyền', 'Tên chuyền', 'Tổ trưởng', 'Thứ tự', 'Trạng thái'];
    styleHeader(lineHeader);
    lines.forEach((line) =>
        sheet.addRow([
            line.code,
            line.name || '',
            line.leaderName || '',
            line.sortOrder || 0,
            line.isActive ? 'Đang dùng' : 'Đã tắt',
        ])
    );
    const itemStart = sheet.rowCount + 3;
    const itemHeader = sheet.getRow(itemStart);
    itemHeader.values = ['Mã hàng', 'Tên hàng', 'Đơn vị', 'Đơn giá (đ/SP)', 'Trạng thái'];
    styleHeader(itemHeader);
    items.forEach((item) =>
        sheet.addRow([
            item.code,
            item.name || '',
            item.unit || 'SP',
            item.unitPrice || 0,
            item.isActive ? 'Đang dùng' : 'Đã tắt',
        ])
    );
    styleDataArea(sheet, 6, Math.max(6, itemStart - 3), 5);
    styleDataArea(sheet, itemStart + 1, sheet.rowCount, 5);
    sheet.columns = [{ width: 17 }, { width: 28 }, { width: 22 }, { width: 18 }, { width: 14 }, { width: 3 }];
    sheet.getColumn(4).numFmt = '#,##0';
    sheet.pageSetup.printArea = `A1:E${sheet.rowCount}`;
};

export const buildProductionWorkbook = async ({
    detail,
    monthDetails,
    lines,
    items,
    plan,
}: {
    detail: any;
    monthDetails: any[];
    lines: any[];
    items: any[];
    plan?: any;
}) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    workbook.company = 'Công ty TNHH May Xuất Khẩu Hải Đăng';
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;

    addDailyReportSheet(workbook, detail);
    addPlanSheet(workbook, detail, plan);
    addEntryLedgerSheet(workbook, detail);
    addMonthlySummarySheet(workbook, detail, monthDetails);
    addItemSummarySheet(workbook, detail, monthDetails);
    addCatalogSheet(workbook, detail, lines, items);

    return workbook;
};
