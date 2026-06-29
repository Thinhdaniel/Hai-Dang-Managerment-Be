import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const thin = { style: 'thin' as const, color: { argb: 'FF4B5563' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const cell = (ws: ExcelJS.Worksheet, address: string) => ws.getCell(address);
const text = (value?: unknown) => String(value ?? '').trim() || '-';

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

const statusLabel: Record<string, string> = {
    pending: 'Chờ duyệt',
    approved: 'Đã duyệt / chờ bàn giao',
    completed: 'Đã hoàn tất',
    rejected: 'Đã từ chối',
    cancelled: 'Đã hủy',
};

const assetStatusLabel: Record<string, string> = {
    active: 'Đang hoạt động',
    maintenance: 'Đang bảo trì',
    broken: 'Lỗi / hỏng',
    borrowing: 'Đang mượn',
    storage: 'Tồn kho',
};

const mergeValue = (
    ws: ExcelJS.Worksheet,
    range: string,
    value: unknown,
    style: Partial<ExcelJS.Style> = {}
) => {
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

const getAssets = (transfer: any) => {
    if (Array.isArray(transfer.assets) && transfer.assets.length) return transfer.assets;
    if (transfer.asset) return [transfer.asset];
    return [];
};

const getAssetId = (asset: any) => String(asset?.id || asset?._id || asset?.assetId || '');

const getSourceAreaByAsset = (transfer: any, asset: any) => {
    const assetId = getAssetId(asset);
    const snapshots = Array.isArray(transfer.sourceSnapshots) ? transfer.sourceSnapshots : [];
    const snapshot = snapshots.find((item: any) => String(item?.assetId || '') === assetId);
    return snapshot?.area || transfer.fromArea || asset?.area || '';
};

const getTransferCode = (transfer: any) =>
    transfer.transferCode ||
    `PXK-DC-${dayjs(transfer.createdAt || new Date()).format('YYYY')}-${String(transfer.id || '').slice(-5).toUpperCase()}`;

export const generateTransferStockOutXlsx = async (transfer: any): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Device Management';
    workbook.created = new Date();

    const ws = workbook.addWorksheet('Phieu xuat kho may', {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
        },
    });

    ws.columns = [
        { width: 6 },
        { width: 15 },
        { width: 28 },
        { width: 18 },
        { width: 22 },
        { width: 16 },
        { width: 17 },
        { width: 17 },
        { width: 16 },
        { width: 24 },
    ];
    ws.views = [{ showGridLines: false }];

    mergeValue(ws, 'A1:D1', 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG', {
        font: { name: FONT, size: 12, bold: true },
    });
    mergeValue(ws, 'A2:D2', 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ', {
        font: { name: FONT, size: 11, italic: true },
    });
    mergeValue(ws, 'H1:J1', `Số phiếu: ${getTransferCode(transfer)}`, {
        font: { name: FONT, size: 11, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    mergeValue(ws, 'H2:J2', `Ngày in: ${formatDateTime(new Date())}`, {
        font: { name: FONT, size: 10, italic: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });

    mergeValue(ws, 'A4:J4', 'PHIẾU XUẤT KHO KIÊM ĐIỀU CHUYỂN MÁY', {
        font: { name: FONT, size: 18, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    ws.getRow(4).height = 30;

    const issueDate = dayjs(transfer.transferDate || transfer.createdAt || new Date());
    mergeValue(ws, 'A5:J5', `Ngày ${issueDate.format('DD')} tháng ${issueDate.format('MM')} năm ${issueDate.format('YYYY')}`, {
        font: { name: FONT, size: 11, italic: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });

    const assets = getAssets(transfer);
    const assetCount = assets.length || Number(transfer.assetIds?.length || 0) || 1;

    setInfo(ws, 7, 'A7:B7', 'C7:J7', 'Căn cứ lệnh điều chuyển:', getTransferCode(transfer));
    setInfo(ws, 8, 'A8:B8', 'C8:E8', 'Cơ sở xuất:', transfer.fromPlant?.name);
    setInfo(ws, 8, 'F8:G8', 'H8:J8', 'Cơ sở nhận:', transfer.toPlant?.name);
    setInfo(ws, 9, 'A9:B9', 'C9:E9', 'Khu vực xuất:', transfer.fromArea || 'Chưa chỉ định');
    setInfo(ws, 9, 'F9:G9', 'H9:J9', 'Khu vực nhận:', transfer.toArea || 'Chưa chỉ định');
    setInfo(ws, 10, 'A10:B10', 'C10:E10', 'Trạng thái lệnh:', statusLabel[transfer.status] || transfer.status);
    setInfo(ws, 10, 'F10:G10', 'H10:J10', 'Số lượng máy:', assetCount);
    setInfo(ws, 11, 'A11:B11', 'C11:J11', 'Lý do xuất kho:', transfer.reason);
    setInfo(ws, 12, 'A12:B12', 'C12:J12', 'Ghi chú:', transfer.note || '-');

    const headerRowIndex = 14;
    const headers = [
        'STT',
        'Mã máy',
        'Tên máy',
        'Serial',
        'Loại / Model',
        'Nhãn hiệu',
        'Khu vực xuất',
        'Khu vực nhận',
        'Tình trạng',
        'Ghi chú',
    ];

    const headerRow = ws.getRow(headerRowIndex);
    headerRow.height = 32;
    headers.forEach((header, index) => {
        const current = headerRow.getCell(index + 1);
        current.value = header;
        current.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        current.border = border;
        current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    });

    const rows = assets.length ? assets : [{}];
    let currentRowIndex = headerRowIndex + 1;

    rows.forEach((asset: any, index: number) => {
        const row = ws.getRow(currentRowIndex);
        row.height = 26;

        const values = [
            index + 1,
            asset.machineCode || '',
            asset.name || '',
            asset.serial || '',
            [asset.type, asset.model].filter(Boolean).join(' / '),
            asset.brand?.name || '',
            getSourceAreaByAsset(transfer, asset),
            transfer.toArea || '',
            assetStatusLabel[asset.status] || asset.status || '',
            asset.note || '',
        ];

        values.forEach((value, valueIndex) => {
            const current = row.getCell(valueIndex + 1);
            current.value = text(value);
            current.font = { name: FONT, size: 11 };
            current.border = border;
            current.alignment = {
                horizontal: valueIndex === 0 ? 'center' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
        });

        currentRowIndex += 1;
    });

    mergeValue(ws, `A${currentRowIndex}:J${currentRowIndex}`, `Tổng số máy xuất kho: ${assetCount}`, {
        font: { name: FONT, size: 11, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    cell(ws, `A${currentRowIndex}`).border = border;
    ws.getRow(currentRowIndex).height = 24;

    const noteRow = currentRowIndex + 2;
    mergeValue(
        ws,
        `A${noteRow}:J${noteRow + 1}`,
        'Cam kết: Các máy nêu trên được xuất kho để điều chuyển đúng tuyến, đúng mục đích. Bên giao và bên nhận chịu trách nhiệm kiểm tra tình trạng máy, phụ kiện đi kèm và hồ sơ bàn giao trước khi ký nhận.',
        {
            font: { name: FONT, size: 10, italic: true },
            alignment: { vertical: 'middle', wrapText: true },
        }
    );

    const signatureRow = noteRow + 3;
    const hintRow = signatureRow + 1;
    const nameRow = signatureRow + 5;
    const signatures = [
        { range: `A${signatureRow}:B${signatureRow}`, hint: `A${hintRow}:B${hintRow}`, name: `A${nameRow}:B${nameRow}`, label: 'Người lập phiếu', value: transfer.createdByName || '' },
        { range: `D${signatureRow}:E${signatureRow}`, hint: `D${hintRow}:E${hintRow}`, name: `D${nameRow}:E${nameRow}`, label: 'Thủ kho / Người xuất', value: transfer.approvedByName || '' },
        { range: `G${signatureRow}:H${signatureRow}`, hint: `G${hintRow}:H${hintRow}`, name: `G${nameRow}:H${nameRow}`, label: 'Người vận chuyển', value: '' },
        { range: `I${signatureRow}:J${signatureRow}`, hint: `I${hintRow}:J${hintRow}`, name: `I${nameRow}:J${nameRow}`, label: 'Người nhận', value: transfer.receivedBy || '' },
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
    ws.pageSetup.printArea = `A1:J${nameRow}`;
    ws.headerFooter.oddFooter = '&LDevice Management&C&P / &N&R';

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
};
