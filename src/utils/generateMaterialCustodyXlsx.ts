import ExcelJS from 'exceljs';

type MaterialCustodyWorkbookInput = {
    plantName: string;
    generatedAt: Date;
    assignments: any[];
    campaigns: any[];
    reusableStock: any[];
    summary: Record<string, number>;
};

const COLORS = {
    navy: '17365D',
    blue: '1F4E78',
    paleBlue: 'D9EAF7',
    green: 'E2F0D9',
    orange: 'FCE4D6',
    red: 'F4CCCC',
    white: 'FFFFFF',
    border: 'B7C9DA',
};

const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } },
};

const formatDate = (value?: Date | string | null) =>
    value ? new Date(value).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';

const campaignStatusLabel = (value: string) =>
    ({ active: 'Đang sử dụng', recalling: 'Đang thu hồi', closed: 'Đã đóng' })[value] || value;

const assignmentStatusLabel = (value: string, overdue: boolean) => {
    if (overdue) return 'Quá hạn';
    return (
        { active: 'Đang giữ', partial: 'Đã trả một phần', recall_due: 'Chờ thu hồi', resolved: 'Đã xử lý đủ' }[value] ||
        value
    );
};

const sourceLabel = (value: string) =>
    ({
        new_stock: 'Cấp mới',
        opening_balance: 'Số dư đầu kỳ',
        reusable_pool: 'Cấp lại',
        custody_transfer: 'Chuyển giữ',
    })[value] || value;

const prepareSheet = (sheet: ExcelJS.Worksheet, title: string, subtitle: string, columnCount: number) => {
    sheet.mergeCells(1, 1, 1, columnCount);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: COLORS.white } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(1).height = 28;

    sheet.mergeCells(2, 1, 2, columnCount);
    const subtitleCell = sheet.getCell(2, 1);
    subtitleCell.value = subtitle;
    subtitleCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: '53687D' } };
    subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    sheet.getRow(2).height = 20;
};

const styleDataTable = (sheet: ExcelJS.Worksheet, headerRowNumber: number) => {
    const header = sheet.getRow(headerRowNumber);
    header.height = 30;
    header.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.white } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.blue } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = thinBorder;
    });
    for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        row.eachCell({ includeEmpty: true }, (cell) => {
            cell.font = { name: 'Arial', size: 10 };
            cell.alignment = { vertical: 'middle', wrapText: true };
            cell.border = thinBorder;
        });
        if (rowNumber % 2 === 0) {
            row.eachCell({ includeEmpty: true }, (cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F7FAFC' } };
            });
        }
    }
    sheet.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber, column: sheet.columnCount },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRowNumber, activeCell: `A${headerRowNumber + 1}` }];
    sheet.pageSetup = {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    };
    sheet.headerFooter.oddFooter = 'Trang &P / &N';
};

export const buildMaterialCustodyWorkbook = (input: MaterialCustodyWorkbookInput) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Management System';
    workbook.created = input.generatedAt;
    workbook.modified = input.generatedAt;

    const subtitle = `${input.plantName} · Xuất lúc ${input.generatedAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
    const overview = workbook.addWorksheet('Tổng quan', { properties: { tabColor: { argb: COLORS.navy } } });
    overview.columns = [{ width: 31 }, { width: 20 }, { width: 49 }];
    prepareSheet(overview, 'BÁO CÁO CCDC VÀ THU HỒI VẬT TƯ', subtitle, 3);
    overview.addRow([]);
    overview.addRow(['CHỈ SỐ', 'GIÁ TRỊ', 'DIỄN GIẢI']);
    const overviewRows = [
        ['Dòng đang giữ', input.summary.openAssignments || 0, 'Các dòng cấp phát còn trách nhiệm chưa xử lý hết'],
        ['Dòng quá hạn', input.summary.overdueAssignments || 0, 'Có hạn thu hồi đã qua và vẫn còn số lượng chưa trả'],
        ['Người / tổ đang giữ', input.summary.activeHolderCount || 0, 'Đếm người nhận hoặc tổ/chuyền còn giữ vật tư'],
        ['Giá trị chưa thu hồi', input.summary.outstandingValue || 0, 'Giá trị tham chiếu theo đơn giá lúc cấp mới'],
        [
            'Vật tư dùng được trong kho tái sử dụng',
            input.summary.reusableAvailableQuantity || 0,
            'Cấp lại không ghi nhận thêm chi phí',
        ],
        ['Vật tư chờ sửa', input.summary.reusableRepairQuantity || 0, 'Đã thu hồi và đang chờ xử lý kỹ thuật'],
        ['Vật tư hỏng', input.summary.reusableDamagedQuantity || 0, 'Đã xác định không còn sử dụng bình thường'],
        ['Đợt đang sử dụng', input.summary.activeCampaigns || 0, 'Mã hàng chưa mở thu hồi'],
        ['Đợt đang thu hồi', input.summary.recallingCampaigns || 0, 'Mã hàng đã kết thúc và đang đối soát'],
    ];
    overviewRows.forEach((row) => overview.addRow(row));
    styleDataTable(overview, 4);
    overview.getColumn(2).numFmt = '#,##0.##';
    overview.getRow(8).getCell(2).numFmt = '#,##0 "đ"';
    overview.pageSetup.orientation = 'portrait';

    const assignments = workbook.addWorksheet('Sổ đang giữ', { properties: { tabColor: { argb: 'ED7D31' } } });
    assignments.columns = [
        { width: 6 },
        { width: 15 },
        { width: 27 },
        { width: 18 },
        { width: 23 },
        { width: 18 },
        { width: 15 },
        { width: 18 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
        { width: 17 },
        { width: 27 },
    ];
    prepareSheet(assignments, 'SỔ TRÁCH NHIỆM VẬT TƯ ĐANG SỬ DỤNG', subtitle, 16);
    assignments.addRow([]);
    assignments.addRow([
        'STT',
        'Mã vật tư',
        'Tên vật tư',
        'Mã CN / tổ',
        'Người / tổ giữ',
        'Bộ phận / chuyền',
        'Mã hàng',
        'Mã đơn / lô',
        'Đã cấp',
        'Đã xử lý',
        'Còn giữ',
        'Đơn vị',
        'Ngày cấp',
        'Hạn thu',
        'Trạng thái',
        'Nguồn / ghi chú',
    ]);
    input.assignments.forEach((row, index) => {
        const returned = Number(row.quantityIssued || 0) - Number(row.outstandingQuantity || 0);
        assignments.addRow([
            index + 1,
            row.materialCode || '',
            row.materialName || '',
            row.holderCode || '',
            row.holderName || '',
            [row.department, row.lineName].filter(Boolean).join(' · '),
            row.itemCode || '',
            row.orderCode || '',
            Number(row.quantityIssued || 0),
            returned,
            Number(row.outstandingQuantity || 0),
            row.unit || '',
            formatDate(row.issuedAt),
            formatDate(row.dueAt),
            assignmentStatusLabel(row.status, row.overdue),
            [sourceLabel(row.sourceType), row.note].filter(Boolean).join(' · '),
        ]);
        if (row.overdue) {
            assignments.getRow(assignments.rowCount).getCell(15).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: COLORS.red },
            };
        }
    });
    styleDataTable(assignments, 4);
    [9, 10, 11].forEach((column) => {
        assignments.getColumn(column).numFmt = '#,##0.##';
    });

    const campaignSheet = workbook.addWorksheet('Đợt mã hàng', { properties: { tabColor: { argb: '7030A0' } } });
    campaignSheet.columns = [
        { width: 6 },
        { width: 17 },
        { width: 16 },
        { width: 29 },
        { width: 18 },
        { width: 16 },
        { width: 13 },
        { width: 13 },
        { width: 13 },
        { width: 13 },
        { width: 17 },
        { width: 30 },
    ];
    prepareSheet(campaignSheet, 'ĐỐI SOÁT THU HỒI THEO MÃ HÀNG', subtitle, 12);
    campaignSheet.addRow([]);
    campaignSheet.addRow([
        'STT',
        'Mã đợt',
        'Mã hàng',
        'Tên mã hàng',
        'Mã đơn / lô',
        'Trạng thái',
        'Người / tổ',
        'Dòng cấp',
        'Đã cấp',
        'Chưa thu',
        'Hạn thu',
        'Ghi chú',
    ]);
    input.campaigns.forEach((row, index) =>
        campaignSheet.addRow([
            index + 1,
            row.campaignCode,
            row.itemCode,
            row.itemName || '',
            row.orderCode || '',
            campaignStatusLabel(row.status),
            Number(row.holderCount || 0),
            Number(row.assignmentCount || 0),
            Number(row.issuedQuantity || 0),
            Number(row.outstandingQuantity || 0),
            formatDate(row.dueAt),
            row.note || '',
        ])
    );
    styleDataTable(campaignSheet, 4);
    [7, 8, 9, 10].forEach((column) => {
        campaignSheet.getColumn(column).numFmt = '#,##0.##';
    });

    const poolSheet = workbook.addWorksheet('Kho tái sử dụng', { properties: { tabColor: { argb: '70AD47' } } });
    poolSheet.columns = [
        { width: 6 },
        { width: 16 },
        { width: 32 },
        { width: 12 },
        { width: 16 },
        { width: 16 },
        { width: 16 },
        { width: 19 },
    ];
    prepareSheet(poolSheet, 'KHO VẬT TƯ TÁI SỬ DỤNG', subtitle, 8);
    poolSheet.addRow([]);
    poolSheet.addRow(['STT', 'Mã vật tư', 'Tên vật tư', 'ĐVT', 'Dùng được', 'Chờ sửa', 'Hỏng', 'Biến động gần nhất']);
    input.reusableStock.forEach((row, index) =>
        poolSheet.addRow([
            index + 1,
            row.materialCode || '',
            row.materialName || '',
            row.unit || '',
            Number(row.availableQuantity || 0),
            Number(row.repairQuantity || 0),
            Number(row.damagedQuantity || 0),
            formatDate(row.lastMovementAt),
        ])
    );
    styleDataTable(poolSheet, 4);
    [5, 6, 7].forEach((column) => {
        poolSheet.getColumn(column).numFmt = '#,##0.##';
    });

    return workbook;
};
