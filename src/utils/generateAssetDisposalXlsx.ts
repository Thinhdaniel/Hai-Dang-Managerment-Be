import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const thin = { style: 'thin' as const, color: { argb: 'FF94A3B8' } };
const medium = { style: 'medium' as const, color: { argb: 'FF334155' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const BATCH_STATUS_LABEL: Record<string, string> = {
    draft: 'Nháp',
    scanning: 'Đang rà soát',
    reviewing: 'Chờ duyệt',
    approved: 'Đã duyệt',
    completed: 'Hoàn tất',
    cancelled: 'Đã hủy',
};

const ITEM_STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ rà soát',
    checked: 'Đã rà soát',
    approved: 'Đã duyệt',
    disposed: 'Đã thanh lý',
    kept: 'Giữ lại',
    cancelled: 'Đã hủy',
};

const SOURCE_LABEL: Record<string, string> = {
    asset: 'Hệ thống',
    external: 'Ngoài hệ thống',
    qr_only: 'QR tạm',
};

const CONDITION_LABEL: Record<string, string> = {
    usable: 'Còn dùng được',
    minor_fault: 'Lỗi nhẹ',
    major_fault: 'Hỏng nặng',
    missing_parts: 'Thiếu linh kiện',
    scrap: 'Phế liệu',
    unknown: 'Chưa rõ',
};

const ACTION_LABEL: Record<string, string> = {
    sell: 'Bán thanh lý',
    part_out: 'Tháo linh kiện',
    scrap: 'Bán phế liệu',
    keep: 'Giữ lại',
    repair: 'Sửa lại',
    unknown: 'Chưa đề xuất',
};

const text = (value?: unknown) => String(value ?? '').trim() || '-';
const codeText = (item: any) => text(item.machineCode || item.asset?.machineCode || item.publicId);
const nameText = (item: any) => text(item.name || item.asset?.name);
const modelSerialText = (item: any) =>
    [item.model || item.asset?.model, item.serial || item.asset?.serial].filter(Boolean).join(' / ') || '-';
const money = (value?: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const formatDateTime = (value?: string | Date) => {
    if (!value) return '-';
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('DD/MM/YYYY HH:mm') : '-';
};

const formatDate = (value?: string | Date) => {
    if (!value) return '-';
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('DD/MM/YYYY') : '-';
};

const cell = (ws: ExcelJS.Worksheet, address: string) => ws.getCell(address);

const mergeValue = (ws: ExcelJS.Worksheet, range: string, value: unknown, style: Partial<ExcelJS.Style> = {}) => {
    ws.mergeCells(range);
    const target = cell(ws, range.split(':')[0]);
    target.value = value as ExcelJS.CellValue;
    target.style = {
        font: { name: FONT, size: 10.5 },
        alignment: { vertical: 'middle', wrapText: true },
        ...style,
    };
    return target;
};

const setInfo = (
    ws: ExcelJS.Worksheet,
    row: number,
    labelRange: string,
    valueRange: string,
    label: string,
    value: unknown
) => {
    mergeValue(ws, labelRange, label, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { vertical: 'middle' },
    });
    mergeValue(ws, valueRange, value, {
        font: { name: FONT, size: 10 },
        alignment: { vertical: 'middle', wrapText: true },
    });
    ws.getRow(row).height = 21;
};

const styleRangeBorder = (ws: ExcelJS.Worksheet, fromRow: number, toRow: number, fromCol = 1, toCol = 7) => {
    for (let row = fromRow; row <= toRow; row += 1) {
        for (let col = fromCol; col <= toCol; col += 1) {
            ws.getCell(row, col).border = border;
        }
    }
};

const buildPrintableSheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const batch = detail.batch ?? {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const summary = detail.summary ?? {};
    const ws = workbook.addWorksheet('Bien ban A4', {
        pageSetup: {
            paperSize: 9,
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            horizontalCentered: true,
            margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 },
        },
    });

    ws.columns = [
        { width: 5 },
        { width: 14 },
        { width: 22 },
        { width: 16 },
        { width: 13 },
        { width: 13 },
        { width: 15 },
    ];
    ws.views = [{ showGridLines: false }];

    mergeValue(ws, 'A1:D1', 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG', {
        font: { name: FONT, size: 11, bold: true },
    });
    mergeValue(ws, 'A2:D2', 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ', {
        font: { name: FONT, size: 9.5, italic: true },
    });
    mergeValue(ws, 'E1:G1', `Mã lô: ${text(batch.code)}`, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    mergeValue(ws, 'E2:G2', `Ngày in: ${formatDateTime(new Date())}`, {
        font: { name: FONT, size: 9.5, italic: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });

    mergeValue(ws, 'A4:G4', 'BIÊN BẢN RÀ SOÁT MÁY ĐỀ NGHỊ THANH LÝ', {
        font: { name: FONT, size: 15, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    ws.getRow(4).height = 25;

    setInfo(ws, 6, 'A6:B6', 'C6:D6', 'Cơ sở:', batch.plant?.name || '-');
    setInfo(ws, 6, 'E6:F6', 'G6:G6', 'Khu vực:', batch.area || 'Tất cả');
    setInfo(ws, 7, 'A7:B7', 'C7:D7', 'Trạng thái:', BATCH_STATUS_LABEL[batch.status] || batch.status);
    setInfo(ws, 7, 'E7:F7', 'G7:G7', 'Số máy:', summary.total ?? items.length);
    setInfo(ws, 8, 'A8:B8', 'C8:G8', 'Lý do:', batch.reason || '-');
    setInfo(ws, 9, 'A9:B9', 'C9:G9', 'Ghi chú:', batch.note || '-');
    styleRangeBorder(ws, 6, 9);

    const tableHeaderRow = 11;
    ws.pageSetup.printTitlesRow = `${tableHeaderRow}:${tableHeaderRow}`;
    const headers = ['STT', 'Mã máy/QR', 'Tên máy', 'Model / Serial', 'Khu vực', 'Tình trạng', 'Xử lý / Giá'];
    headers.forEach((header, index) => {
        const current = ws.getRow(tableHeaderRow).getCell(index + 1);
        current.value = header;
        current.font = { name: FONT, size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
        current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        current.border = { top: medium, left: thin, bottom: medium, right: thin };
        current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    });
    ws.getRow(tableHeaderRow).height = 27;

    let rowIndex = tableHeaderRow + 1;
    const rows = items.length ? items : [{}];
    rows.forEach((item: any, index: number) => {
        const row = ws.getRow(rowIndex);
        row.height = 38;
        const finalValue = money(item.finalValue);
        const estimatedValue = money(item.estimatedValue);
        const values = [
            index + 1,
            codeText(item),
            nameText(item),
            modelSerialText(item),
            text(item.area || item.asset?.area),
            CONDITION_LABEL[item.condition] || item.condition || '-',
            `${ACTION_LABEL[item.suggestedAction] || item.suggestedAction || '-'}\n${
                finalValue
                    ? finalValue.toLocaleString('vi-VN')
                    : estimatedValue
                      ? `ƯT ${estimatedValue.toLocaleString('vi-VN')}`
                      : '-'
            }`,
        ];

        values.forEach((value, valueIndex) => {
            const current = row.getCell(valueIndex + 1);
            current.value = value;
            current.font = { name: FONT, size: 9 };
            current.border = border;
            current.alignment = {
                horizontal: valueIndex === 0 ? 'center' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
        });
        rowIndex += 1;
    });

    const totalRow = rowIndex;
    mergeValue(ws, `A${totalRow}:D${totalRow}`, `Tổng số máy đề nghị thanh lý: ${items.length}`, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    mergeValue(
        ws,
        `E${totalRow}:G${totalRow}`,
        `Tổng giá chốt: ${items.reduce((sum: number, item: any) => sum + money(item.finalValue), 0).toLocaleString('vi-VN')} đ`,
        {
            font: { name: FONT, size: 10, bold: true },
            alignment: { horizontal: 'right', vertical: 'middle' },
        }
    );
    styleRangeBorder(ws, totalRow, totalRow);

    const noteRow = totalRow + 2;
    mergeValue(
        ws,
        `A${noteRow}:G${noteRow + 1}`,
        'Ghi chú: Biên bản này dùng để rà soát, phê duyệt và lưu hồ sơ thanh lý. Các thông tin chi tiết phục vụ lọc/tra cứu nằm tại sheet "Du lieu chi tiet".',
        {
            font: { name: FONT, size: 9, italic: true },
            alignment: { vertical: 'middle', wrapText: true },
        }
    );

    const signatureRow = noteRow + 3;
    const hintRow = signatureRow + 1;
    const nameRow = signatureRow + 5;
    const signatures = [
        {
            range: `A${signatureRow}:B${signatureRow}`,
            hint: `A${hintRow}:B${hintRow}`,
            name: `A${nameRow}:B${nameRow}`,
            label: 'Người lập',
            value: batch.createdByName || batch.submittedByName || '',
        },
        {
            range: `C${signatureRow}:D${signatureRow}`,
            hint: `C${hintRow}:D${hintRow}`,
            name: `C${nameRow}:D${nameRow}`,
            label: 'Kỹ thuật',
            value: '',
        },
        {
            range: `E${signatureRow}:F${signatureRow}`,
            hint: `E${hintRow}:F${hintRow}`,
            name: `E${nameRow}:F${nameRow}`,
            label: 'Kế toán / QLTS',
            value: batch.approvedByName || '',
        },
        {
            range: `G${signatureRow}:G${signatureRow}`,
            hint: `G${hintRow}:G${hintRow}`,
            name: `G${nameRow}:G${nameRow}`,
            label: 'Duyệt',
            value: batch.completedByName || '',
        },
    ];

    signatures.forEach((signature) => {
        mergeValue(ws, signature.range, signature.label, {
            font: { name: FONT, size: 10, bold: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
        mergeValue(ws, signature.hint, '(Ký, ghi rõ họ tên)', {
            font: { name: FONT, size: 9, italic: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
        mergeValue(ws, signature.name, signature.value, {
            font: { name: FONT, size: 10, bold: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
    });

    ws.pageSetup.printArea = `A1:G${nameRow}`;
};

const buildDetailSheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const batch = detail.batch ?? {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const ws = workbook.addWorksheet('Du lieu chi tiet', {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
        },
    });

    ws.columns = [
        { header: 'STT', key: 'index', width: 6 },
        { header: 'Mã lô', key: 'batchCode', width: 16 },
        { header: 'Mã máy/QR', key: 'code', width: 18 },
        { header: 'Tên máy', key: 'name', width: 28 },
        { header: 'Nguồn', key: 'source', width: 15 },
        { header: 'Loại', key: 'type', width: 16 },
        { header: 'Model', key: 'model', width: 16 },
        { header: 'Serial', key: 'serial', width: 18 },
        { header: 'Cơ sở', key: 'plant', width: 22 },
        { header: 'Khu vực', key: 'area', width: 18 },
        { header: 'Tình trạng', key: 'condition', width: 18 },
        { header: 'Đề xuất', key: 'suggestedAction', width: 18 },
        { header: 'Giá ước tính', key: 'estimatedValue', width: 15 },
        { header: 'Giá chốt', key: 'finalValue', width: 15 },
        { header: 'Trạng thái', key: 'status', width: 16 },
        { header: 'Ngày rà soát', key: 'checkedAt', width: 18 },
        { header: 'Lý do', key: 'reason', width: 26 },
        { header: 'Ghi chú', key: 'note', width: 26 },
    ];
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const header = ws.getRow(1);
    header.height = 28;
    header.eachCell((current) => {
        current.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        current.border = border;
        current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    });

    items.forEach((item: any, index: number) => {
        ws.addRow({
            index: index + 1,
            batchCode: batch.code,
            code: codeText(item),
            name: nameText(item),
            source: SOURCE_LABEL[item.sourceType] || item.sourceType,
            type: item.type || item.asset?.type || '',
            model: item.model || item.asset?.model || '',
            serial: item.serial || item.asset?.serial || '',
            plant: item.plant?.name || item.asset?.plant?.name || '',
            area: item.area || item.asset?.area || '',
            condition: CONDITION_LABEL[item.condition] || item.condition || '',
            suggestedAction: ACTION_LABEL[item.suggestedAction] || item.suggestedAction || '',
            estimatedValue: money(item.estimatedValue) || '',
            finalValue: money(item.finalValue) || '',
            status: ITEM_STATUS_LABEL[item.status] || item.status,
            checkedAt: formatDate(item.checkedAt || item.disposedAt || item.updatedAt),
            reason: item.reason || batch.reason || '',
            note: item.note || '',
        });
    });

    ws.eachRow((row, rowNumber) => {
        row.eachCell((current, colNumber) => {
            current.font = { name: FONT, size: rowNumber === 1 ? 10 : 9.5 };
            current.border = border;
            current.alignment = {
                horizontal: colNumber === 1 ? 'center' : colNumber === 13 || colNumber === 14 ? 'right' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
            if (colNumber === 13 || colNumber === 14) current.numFmt = '#,##0';
        });
        if (rowNumber > 1) row.height = 24;
    });

    ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(items.length + 1, 1), column: ws.columns.length },
    };
};

export const generateAssetDisposalXlsx = async (detail: any): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hai Dang Management';
    workbook.created = new Date();

    buildPrintableSheet(workbook, detail);
    buildDetailSheet(workbook, detail);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
};
