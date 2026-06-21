import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const thin = { style: 'thin' as const, color: { argb: 'FF64748B' } };
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
    asset: 'Trong hệ thống',
    external: 'Ngoài hệ thống',
    qr_only: 'Tem QR tạm',
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
const cell = (ws: ExcelJS.Worksheet, address: string) => ws.getCell(address);

const formatDate = (value?: string | Date) => {
    if (!value) return '-';
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('DD/MM/YYYY') : '-';
};

const formatDateTime = (value?: string | Date) => {
    if (!value) return '-';
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('DD/MM/YYYY HH:mm') : '-';
};

const mergeValue = (ws: ExcelJS.Worksheet, range: string, value: unknown, style: Partial<ExcelJS.Style> = {}) => {
    ws.mergeCells(range);
    const topLeft = range.split(':')[0];
    const target = cell(ws, topLeft);
    target.value = value as ExcelJS.CellValue;
    target.style = {
        font: { name: FONT, size: 11 },
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
        font: { name: FONT, size: 11, bold: true },
        alignment: { vertical: 'middle' },
    });
    mergeValue(ws, valueRange, text(value), {
        font: { name: FONT, size: 11 },
        alignment: { vertical: 'middle', wrapText: true },
    });
    ws.getRow(row).height = 22;
};

const styleBox = (ws: ExcelJS.Worksheet, range: string, fillArgb: string) => {
    const [from, to] = range.split(':');
    const start = ws.getCell(from);
    const end = ws.getCell(to);
    for (let row = start.row; row <= end.row; row += 1) {
        for (let col = start.col; col <= end.col; col += 1) {
            const current = ws.getCell(row, col);
            current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
            current.border = border;
            current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            current.font = { name: FONT, size: 11, bold: true, color: { argb: 'FF0F172A' } };
        }
    }
};

const resolveCode = (item: any) => item.machineCode || item.asset?.machineCode || item.publicId || '';
const resolveName = (item: any) => item.name || item.asset?.name || 'Máy chưa định danh';
const sumNumber = (items: any[], key: string) =>
    items.reduce((total, item) => total + (Number.isFinite(Number(item?.[key])) ? Number(item[key]) : 0), 0);

export const generateAssetDisposalXlsx = async (detail: any): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hai Dang Management';
    workbook.created = new Date();

    const ws = workbook.addWorksheet('Danh sach thanh ly may', {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            margins: { left: 0.25, right: 0.25, top: 0.38, bottom: 0.38, header: 0.15, footer: 0.15 },
        },
    });

    ws.columns = [
        { width: 6 },
        { width: 17 },
        { width: 26 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
        { width: 18 },
        { width: 15 },
        { width: 16 },
        { width: 17 },
        { width: 28 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
        { width: 16 },
        { width: 24 },
    ];
    ws.views = [{ state: 'frozen', ySplit: 15, showGridLines: false }];

    const batch = detail.batch ?? {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const summary = detail.summary ?? {};

    mergeValue(ws, 'A1:H1', 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG', {
        font: { name: FONT, size: 12, bold: true },
    });
    mergeValue(ws, 'A2:H2', 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ', {
        font: { name: FONT, size: 11, italic: true },
    });
    mergeValue(ws, 'M1:P1', `Mã đợt: ${text(batch.code)}`, {
        font: { name: FONT, size: 11, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    mergeValue(ws, 'M2:P2', `Ngày in: ${formatDateTime(new Date())}`, {
        font: { name: FONT, size: 10, italic: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });

    mergeValue(ws, 'A4:P4', 'DANH SÁCH MÁY ĐỀ NGHỊ THANH LÝ', {
        font: { name: FONT, size: 18, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    ws.getRow(4).height = 30;
    mergeValue(ws, 'A5:P5', `Lập ngày ${dayjs(batch.createdAt || new Date()).format('DD/MM/YYYY')}`, {
        font: { name: FONT, size: 11, italic: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });

    setInfo(ws, 7, 'A7:B7', 'C7:F7', 'Cơ sở:', batch.plant?.name);
    setInfo(ws, 7, 'G7:H7', 'I7:K7', 'Khu vực:', batch.area || 'Tất cả');
    setInfo(ws, 7, 'L7:M7', 'N7:P7', 'Trạng thái:', BATCH_STATUS_LABEL[batch.status] || batch.status);
    setInfo(ws, 8, 'A8:B8', 'C8:K8', 'Lý do thanh lý:', batch.reason);
    setInfo(ws, 8, 'L8:M8', 'N8:P8', 'Người lập:', batch.createdByName || batch.submittedByName);
    setInfo(ws, 9, 'A9:B9', 'C9:F9', 'Ngày gửi duyệt:', formatDateTime(batch.submittedAt));
    setInfo(ws, 9, 'G9:H9', 'I9:K9', 'Ngày duyệt:', formatDateTime(batch.approvedAt));
    setInfo(ws, 9, 'L9:M9', 'N9:P9', 'Ngày hoàn tất:', formatDateTime(batch.completedAt));

    const summaryRow = 11;
    const summaryBoxes = [
        { range: 'A11:D12', label: `Tổng máy\n${summary.total ?? items.length}` },
        { range: 'E11:H12', label: `Trong hệ thống\n${summary.asset ?? 0}` },
        { range: 'I11:L12', label: `Ngoài hệ thống/QR tạm\n${(summary.external ?? 0) + (summary.qrOnly ?? 0)}` },
        { range: 'M11:P12', label: `Đã thanh lý\n${summary.disposed ?? 0}` },
    ];
    summaryBoxes.forEach((box) => {
        mergeValue(ws, box.range, box.label, {
            font: { name: FONT, size: 12, bold: true },
            alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
        });
        styleBox(ws, box.range, 'FFEFF6FF');
    });
    ws.getRow(summaryRow).height = 26;
    ws.getRow(summaryRow + 1).height = 26;

    const headerRowIndex = 15;
    const headers = [
        'STT',
        'Mã máy / QR',
        'Tên máy',
        'Nguồn',
        'Loại',
        'Model / Serial',
        'Cơ sở',
        'Khu vực',
        'Tình trạng',
        'Đề xuất xử lý',
        'Lý do / Ghi nhận',
        'Giá ước tính',
        'Giá chốt',
        'Trạng thái',
        'Ngày rà soát',
        'Ghi chú',
    ];

    const headerRow = ws.getRow(headerRowIndex);
    headerRow.height = 34;
    headers.forEach((header, index) => {
        const current = headerRow.getCell(index + 1);
        current.value = header;
        current.font = { name: FONT, size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
        current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        current.border = border;
        current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    });

    let currentRowIndex = headerRowIndex + 1;
    const rows = items.length ? items : [{}];
    rows.forEach((item: any, index: number) => {
        const row = ws.getRow(currentRowIndex);
        row.height = 31;
        const values = [
            index + 1,
            resolveCode(item),
            resolveName(item),
            SOURCE_LABEL[item.sourceType] || item.sourceType || '',
            item.type || item.asset?.type || '',
            [item.model || item.asset?.model, item.serial || item.asset?.serial].filter(Boolean).join(' / '),
            item.plant?.name || item.asset?.plant?.name || '',
            item.area || item.asset?.area || '',
            CONDITION_LABEL[item.condition] || item.condition || '',
            ACTION_LABEL[item.suggestedAction] || item.suggestedAction || '',
            item.reason || '',
            Number(item.estimatedValue || 0) || '',
            Number(item.finalValue || 0) || '',
            ITEM_STATUS_LABEL[item.status] || item.status || '',
            formatDateTime(item.checkedAt || item.disposedAt || item.updatedAt),
            item.note || '',
        ];

        values.forEach((value, valueIndex) => {
            const current = row.getCell(valueIndex + 1);
            current.value = value as ExcelJS.CellValue;
            current.font = { name: FONT, size: 10.5 };
            current.border = border;
            current.alignment = {
                horizontal: valueIndex === 0 ? 'center' : valueIndex === 11 || valueIndex === 12 ? 'right' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
            if (valueIndex === 11 || valueIndex === 12) {
                current.numFmt = '#,##0';
            }
        });

        currentRowIndex += 1;
    });

    ws.autoFilter = {
        from: { row: headerRowIndex, column: 1 },
        to: { row: headerRowIndex, column: headers.length },
    };

    const totalRow = ws.getRow(currentRowIndex);
    totalRow.height = 25;
    mergeValue(ws, `A${currentRowIndex}:K${currentRowIndex}`, `Tổng cộng: ${items.length} máy`, {
        font: { name: FONT, size: 11, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    [12, 13].forEach((col) => {
        const current = totalRow.getCell(col);
        current.value = col === 12 ? sumNumber(items, 'estimatedValue') : sumNumber(items, 'finalValue');
        current.font = { name: FONT, size: 11, bold: true };
        current.alignment = { horizontal: 'right', vertical: 'middle' };
        current.border = border;
        current.numFmt = '#,##0';
    });
    mergeValue(ws, `N${currentRowIndex}:P${currentRowIndex}`, BATCH_STATUS_LABEL[batch.status] || batch.status || '-', {
        font: { name: FONT, size: 11, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });

    const noteRow = currentRowIndex + 2;
    mergeValue(
        ws,
        `A${noteRow}:P${noteRow + 1}`,
        'Ghi chú: Danh sách này dùng cho rà soát tình trạng, phê duyệt và lưu hồ sơ thanh lý máy. Máy đã hoàn tất thanh lý cần giữ hồ sơ trên hệ thống để tra cứu mã máy, QR, nguyên giá tham chiếu và lịch sử xử lý.',
        {
            font: { name: FONT, size: 10, italic: true },
            alignment: { vertical: 'middle', wrapText: true },
        }
    );

    const signatureRow = noteRow + 3;
    const hintRow = signatureRow + 1;
    const nameRow = signatureRow + 5;
    const signatures = [
        {
            range: `A${signatureRow}:D${signatureRow}`,
            hint: `A${hintRow}:D${hintRow}`,
            name: `A${nameRow}:D${nameRow}`,
            label: 'Người lập danh sách',
            value: batch.createdByName || batch.submittedByName || '',
        },
        {
            range: `E${signatureRow}:H${signatureRow}`,
            hint: `E${hintRow}:H${hintRow}`,
            name: `E${nameRow}:H${nameRow}`,
            label: 'Bộ phận kỹ thuật',
            value: '',
        },
        {
            range: `I${signatureRow}:L${signatureRow}`,
            hint: `I${hintRow}:L${hintRow}`,
            name: `I${nameRow}:L${nameRow}`,
            label: 'Kế toán / QL tài sản',
            value: batch.approvedByName || '',
        },
        {
            range: `M${signatureRow}:P${signatureRow}`,
            hint: `M${hintRow}:P${hintRow}`,
            name: `M${nameRow}:P${nameRow}`,
            label: 'Ban giám đốc',
            value: batch.completedByName || '',
        },
    ];

    signatures.forEach((signature) => {
        mergeValue(ws, signature.range, signature.label, {
            font: { name: FONT, size: 11, bold: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
        mergeValue(ws, signature.hint, '(Ký, ghi rõ họ tên)', {
            font: { name: FONT, size: 10, italic: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
        mergeValue(ws, signature.name, signature.value, {
            font: { name: FONT, size: 11, bold: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
    });

    ws.getRow(nameRow).height = 24;
    ws.pageSetup.printArea = `A1:P${nameRow}`;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
};
