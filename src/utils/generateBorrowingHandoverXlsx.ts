import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

// Biên bản bàn giao máy mượn/thuê với đối tác — in ký 2 bên khi nhận hoặc trả máy.
// Máy nhận "không tem" (không dán QR lên máy khách) nhận diện bằng serial + mã máy đối tác.

const FONT = 'Times New Roman';
const NAVY = 'FF1F4E78';
const LIGHT = 'FFEEF2F7';
const thin = { style: 'thin' as const, color: { argb: 'FF94A3B8' } };
const medium = { style: 'medium' as const, color: { argb: 'FF334155' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const TYPE_LABEL: Record<string, string> = {
    external: 'Mượn máy đối tác',
    rental: 'Thuê máy',
};

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

const mergeValue = (ws: ExcelJS.Worksheet, range: string, value: unknown, style: Partial<ExcelJS.Style> = {}) => {
    ws.mergeCells(range);
    const target = ws.getCell(range.split(':')[0]);
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

const styleRangeBorder = (ws: ExcelJS.Worksheet, fromRow: number, toRow: number, fromCol = 1, toCol = 9) => {
    for (let row = fromRow; row <= toRow; row += 1) {
        for (let col = fromCol; col <= toCol; col += 1) {
            ws.getCell(row, col).border = border;
        }
    }
};

export const generateBorrowingHandoverXlsx = async (detail: any): Promise<Buffer> => {
    const batch = detail.batch ?? {};
    const items: any[] = Array.isArray(detail.items) ? detail.items : [];
    const activeItems = items.filter((item) => item.status === 'active');
    const returnedItems = items.filter((item) => item.status === 'returned');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hai Dang Management';
    workbook.created = new Date();

    const ws = workbook.addWorksheet('Bien ban', {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            horizontalCentered: true,
            margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 },
        },
    });

    // A..I (9 cột): STT, Mã máy HD, Tên máy, Model/Serial, Mã máy đối tác, Ngày nhận, Tình trạng nhận, Ngày trả, Tình trạng trả
    ws.columns = [
        { width: 5 },
        { width: 15 },
        { width: 26 },
        { width: 18 },
        { width: 13 },
        { width: 12 },
        { width: 20 },
        { width: 12 },
        { width: 20 },
    ];
    ws.views = [{ showGridLines: false }];

    mergeValue(ws, 'A1:E1', 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG', { font: { name: FONT, size: 11, bold: true } });
    mergeValue(ws, 'A2:E2', 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ', {
        font: { name: FONT, size: 9.5, italic: true },
    });
    mergeValue(ws, 'F1:I1', `Mã lô: ${text(batch.code)}`, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    mergeValue(ws, 'F2:I2', `Ngày in: ${formatDateTime(new Date())}`, {
        font: { name: FONT, size: 9.5, italic: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });

    mergeValue(ws, 'A4:I4', 'BIÊN BẢN BÀN GIAO MÁY MƯỢN / THUÊ', {
        font: { name: FONT, size: 15, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    ws.getRow(4).height = 25;

    setInfo(ws, 6, 'A6:B6', 'C6:E6', 'Đối tác:', text(batch.partnerName));
    setInfo(ws, 6, 'F6:G6', 'H6:I6', 'Loại:', TYPE_LABEL[batch.type] || text(batch.type));
    setInfo(ws, 7, 'A7:B7', 'C7:E7', 'Số hợp đồng / biên bản:', text(batch.contractNo));
    setInfo(ws, 7, 'F7:G7', 'H7:I7', 'Cơ sở / khu vực:', `${batch.plant?.name || '-'}${batch.area ? ` — ${batch.area}` : ''}`);
    setInfo(ws, 8, 'A8:B8', 'C8:E8', 'Ngày nhận máy:', formatDateTime(batch.borrowTime));
    setInfo(ws, 8, 'F8:G8', 'H8:I8', 'Hạn trả dự kiến:', formatDateTime(batch.expectedReturnTime));
    setInfo(
        ws,
        9,
        'A9:B9',
        'C9:E9',
        'Số máy:',
        `${items.length} máy (đang giữ ${activeItems.length}, đã trả ${returnedItems.length})`
    );
    setInfo(ws, 9, 'F9:G9', 'H9:I9', 'Ghi chú:', text(batch.note));
    styleRangeBorder(ws, 6, 9, 1, 9);

    const tableHeaderRow = 11;
    ws.pageSetup.printTitlesRow = `${tableHeaderRow}:${tableHeaderRow}`;
    const headers = [
        'STT',
        'Mã máy HD',
        'Tên máy / Nhãn hiệu',
        'Model / Serial',
        'Mã máy đối tác',
        'Ngày nhận',
        'Tình trạng lúc nhận',
        'Ngày trả',
        'Tình trạng khi trả',
    ];
    headers.forEach((header, index) => {
        const current = ws.getRow(tableHeaderRow).getCell(index + 1);
        current.value = header;
        current.font = { name: FONT, size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
        current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        current.border = { top: medium, left: thin, bottom: medium, right: thin };
        current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    });
    ws.getRow(tableHeaderRow).height = 27;

    let rowIndex = tableHeaderRow + 1;
    items.forEach((item, index) => {
        const asset = item.asset ?? {};
        const brand = String(asset.brand?.name ?? '').trim();
        const modelSerial = [asset.model, asset.serial].filter(Boolean).join(' / ') || '-';
        const row = ws.getRow(rowIndex);
        row.height = 32;
        const values: Array<string | number> = [
            index + 1,
            text(asset.machineCode),
            brand ? `${text(asset.name)}\n(Nhãn: ${brand})` : text(asset.name),
            modelSerial,
            text(item.partnerMachineCode),
            formatDate(item.borrowTime),
            text(item.receiveCondition || item.receiveNote),
            item.returnTime ? formatDate(item.returnTime) : 'Đang giữ',
            text(item.returnCondition || item.returnNote),
        ];
        values.forEach((value, valueIndex) => {
            const current = row.getCell(valueIndex + 1);
            current.value = value as ExcelJS.CellValue;
            current.font = { name: FONT, size: 9 };
            current.border = border;
            current.alignment = {
                horizontal: valueIndex === 0 || valueIndex === 5 || valueIndex === 7 ? 'center' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
        });
        rowIndex += 1;
    });

    if (!items.length) {
        mergeValue(ws, `A${rowIndex}:I${rowIndex}`, 'Chưa có máy nào trong lô', {
            font: { name: FONT, size: 9.5, italic: true },
            alignment: { horizontal: 'center', vertical: 'middle' },
        });
        styleRangeBorder(ws, rowIndex, rowIndex, 1, 9);
        rowIndex += 1;
    }

    const totalRow = rowIndex;
    mergeValue(
        ws,
        `A${totalRow}:I${totalRow}`,
        `TỔNG CỘNG: ${items.length} máy — đang giữ ${activeItems.length}, đã trả ${returnedItems.length}`,
        {
            font: { name: FONT, size: 10, bold: true },
            alignment: { horizontal: 'right', vertical: 'middle' },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } },
        }
    );
    styleRangeBorder(ws, totalRow, totalRow, 1, 9);
    rowIndex += 2;

    mergeValue(
        ws,
        `A${rowIndex}:I${rowIndex + 1}`,
        'Hai bên xác nhận số lượng và tình trạng máy như danh sách trên. Biên bản lập thành 02 bản, mỗi bên giữ 01 bản có giá trị như nhau. Máy không dán tem QR được nhận diện bằng serial và mã máy đối tác.',
        { font: { name: FONT, size: 9, italic: true }, alignment: { vertical: 'middle', wrapText: true } }
    );

    const signatureRow = rowIndex + 3;
    const hintRow = signatureRow + 1;
    const nameRow = signatureRow + 5;
    const signatures = [
        { range: `A${signatureRow}:C${signatureRow}`, hint: `A${hintRow}:C${hintRow}`, label: 'Người lập biên bản' },
        { range: `D${signatureRow}:F${signatureRow}`, hint: `D${hintRow}:F${hintRow}`, label: 'Đại diện Hải Đăng' },
        { range: `G${signatureRow}:I${signatureRow}`, hint: `G${hintRow}:I${hintRow}`, label: 'Đại diện đối tác' },
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
    });

    ws.pageSetup.printArea = `A1:I${nameRow}`;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
};
