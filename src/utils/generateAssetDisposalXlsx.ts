import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const NAVY = 'FF1F4E78';
const LIGHT = 'FFEEF2F7';
const SUBTOTAL = 'FFDCE6F1';
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

const OWNERSHIP_LABEL: Record<string, string> = {
    owned: 'Sở hữu',
    partner_borrowed: 'Đối tác cho mượn',
    rental: 'Thuê',
};

// Thứ tự hiển thị cố định cho các bảng phân loại theo tình trạng / đề xuất xử lý.
const CONDITION_ORDER: Array<[string, string]> = [
    ['usable', 'Còn dùng được'],
    ['minor_fault', 'Lỗi nhẹ'],
    ['major_fault', 'Hỏng nặng'],
    ['missing_parts', 'Thiếu linh kiện'],
    ['scrap', 'Phế liệu'],
    ['unknown', 'Chưa rõ'],
];
const CONDITION_LABEL: Record<string, string> = Object.fromEntries(CONDITION_ORDER);

const ACTION_ORDER: Array<[string, string]> = [
    ['sell', 'Bán thanh lý'],
    ['part_out', 'Tháo linh kiện'],
    ['scrap', 'Bán phế liệu'],
    ['repair', 'Sửa lại'],
    ['keep', 'Giữ lại'],
    ['unknown', 'Chưa đề xuất'],
];
const ACTION_LABEL: Record<string, string> = Object.fromEntries(ACTION_ORDER);

const UNCLASSIFIED = 'Khác / Ngoài hệ thống';

const text = (value?: unknown) => String(value ?? '').trim() || '-';
const money = (value?: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const codeText = (item: any) => text(item.machineCode || item.asset?.machineCode || item.publicId);
const nameText = (item: any) => text(item.name || item.asset?.name);
const brandText = (item: any) => String(item.asset?.brand?.name ?? '').trim();
const typeText = (item: any) => String(item.type || item.asset?.type || '').trim();
// Gom nhóm theo TÊN máy (đã chuẩn, vd "Máy 1 kim") chứ KHÔNG theo trường type —
// type nhập tự do, lẫn nhiều mã viết tắt (1k / M1K / vs4c…) nên cùng một loại máy
// bị tách thành nhiều nhóm. Tên trống mới fallback sang type rồi tới "Khác".
const categoryKey = (item: any) => {
    const name = String(item.name || item.asset?.name || '').trim();
    return name || typeText(item) || UNCLASSIFIED;
};
const ownershipText = (item: any) => {
    const value = item.asset?.ownershipType;
    return value ? OWNERSHIP_LABEL[value] || value : '';
};
const modelSerialText = (item: any) =>
    [item.model || item.asset?.model, item.serial || item.asset?.serial].filter(Boolean).join(' / ') || '-';

// Tên máy + nhãn hiệu trên một ô (dùng cho biên bản in để tiết kiệm cột).
const nameBrandText = (item: any) => {
    const brand = brandText(item);
    return brand ? `${nameText(item)}\n(Nhãn: ${brand})` : nameText(item);
};

const purchaseDateOf = (item: any) => item.asset?.purchaseDate;
// Nguyên giá: trả số nếu > 0, ngược lại '' để không hiển thị 0 với máy ngoài hệ thống.
const purchasePriceCell = (item: any): number | '' => {
    const value = Number(item.asset?.purchasePrice);
    return Number.isFinite(value) && value > 0 ? value : '';
};
const purchaseSum = (item: any) => Number(purchasePriceCell(item) || 0);
// Giá trị thu hồi dùng để tính tỷ lệ: ưu tiên giá chốt, chưa có thì lấy giá ước tính.
const recoveryValue = (item: any) => money(item.finalValue) || money(item.estimatedValue);

const purchaseYearText = (item: any) => {
    const parsed = dayjs(purchaseDateOf(item));
    return purchaseDateOf(item) && parsed.isValid() ? parsed.format('YYYY') : '-';
};
const ageYears = (item: any): number | '' => {
    const raw = purchaseDateOf(item);
    if (!raw) return '';
    const start = dayjs(raw);
    if (!start.isValid()) return '';
    const end = dayjs(item.disposedAt && dayjs(item.disposedAt).isValid() ? item.disposedAt : new Date());
    const years = end.diff(start, 'month') / 12;
    return years >= 0 ? Math.round(years * 10) / 10 : '';
};

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

type RowStyle = {
    size?: number;
    bold?: boolean;
    color?: string;
    fill?: string;
    align?: Array<'left' | 'center' | 'right'>;
    numFmt?: Array<string | undefined>;
    height?: number;
};

// Ghi một hàng giá trị bắt đầu từ cột startCol, kèm style/format theo từng cột.
const putRow = (
    ws: ExcelJS.Worksheet,
    rowNum: number,
    startCol: number,
    values: Array<string | number>,
    style: RowStyle = {}
) => {
    values.forEach((value, index) => {
        const current = ws.getCell(rowNum, startCol + index);
        current.value = value as ExcelJS.CellValue;
        current.font = {
            name: FONT,
            size: style.size ?? 10,
            bold: !!style.bold,
            color: style.color ? { argb: style.color } : undefined,
        };
        current.alignment = { vertical: 'middle', horizontal: style.align?.[index] ?? 'left', wrapText: true };
        current.border = border;
        if (style.fill) current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
        const fmt = style.numFmt?.[index];
        if (fmt) current.numFmt = fmt;
    });
    if (style.height) ws.getRow(rowNum).height = style.height;
};

type Aggregate = { count: number; purchase: number; estimated: number; final: number; recovery: number };

const summarize = (list: any[]): Aggregate =>
    list.reduce<Aggregate>(
        (acc, item) => ({
            count: acc.count + 1,
            purchase: acc.purchase + purchaseSum(item),
            estimated: acc.estimated + money(item.estimatedValue),
            final: acc.final + money(item.finalValue),
            recovery: acc.recovery + recoveryValue(item),
        }),
        { count: 0, purchase: 0, estimated: 0, final: 0, recovery: 0 }
    );

// Gom item theo loại máy, sắp giảm dần theo số lượng rồi theo tên loại.
const groupByType = (items: any[]): Array<[string, any[]]> => {
    const map = new Map<string, any[]>();
    items.forEach((item) => {
        const key = categoryKey(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(item);
    });
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'vi'));
};

const rateOf = (agg: Aggregate): number | '' => (agg.purchase > 0 ? agg.recovery / agg.purchase : '');

const MONEY_FMT = '#,##0';
const PCT_FMT = '0.0%';
const BREAKDOWN_ALIGN: Array<'left' | 'center' | 'right'> = ['left', 'center', 'right', 'right', 'right', 'center'];
const BREAKDOWN_NUMFMT = ['', '', MONEY_FMT, MONEY_FMT, MONEY_FMT, PCT_FMT];

// Ghi một bảng phân loại 6 cột (Nhóm / SL / Nguyên giá / Ước tính / Giá chốt / % thu hồi).
const writeBreakdownTable = (
    ws: ExcelJS.Worksheet,
    startRow: number,
    title: string,
    firstLabel: string,
    rows: Array<{ label: string; agg: Aggregate }>
): number => {
    let r = startRow;
    mergeValue(ws, `B${r}:G${r}`, title, {
        font: { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
        alignment: { horizontal: 'left', vertical: 'middle' },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } },
    });
    ws.getRow(r).height = 20;
    r += 1;

    putRow(ws, r, 2, [firstLabel, 'SL', 'Nguyên giá', 'Giá ước tính', 'Giá chốt', '% thu hồi'], {
        bold: true,
        size: 9.5,
        fill: LIGHT,
        align: BREAKDOWN_ALIGN,
        height: 20,
    });
    r += 1;

    rows.forEach(({ label, agg }) => {
        const rate = rateOf(agg);
        putRow(
            ws,
            r,
            2,
            [label, agg.count, agg.purchase || '', agg.estimated || '', agg.final || '', rate === '' ? '-' : rate],
            { size: 9.5, align: BREAKDOWN_ALIGN, numFmt: BREAKDOWN_NUMFMT }
        );
        r += 1;
    });

    const totalsAgg = rows.reduce<Aggregate>(
        (acc, { agg }) => ({
            count: acc.count + agg.count,
            purchase: acc.purchase + agg.purchase,
            estimated: acc.estimated + agg.estimated,
            final: acc.final + agg.final,
            recovery: acc.recovery + agg.recovery,
        }),
        { count: 0, purchase: 0, estimated: 0, final: 0, recovery: 0 }
    );
    const totalRate = rateOf(totalsAgg);
    putRow(
        ws,
        r,
        2,
        [
            'Tổng cộng',
            totalsAgg.count,
            totalsAgg.purchase || '',
            totalsAgg.estimated || '',
            totalsAgg.final || '',
            totalRate === '' ? '-' : totalRate,
        ],
        { bold: true, size: 9.5, fill: SUBTOTAL, align: BREAKDOWN_ALIGN, numFmt: BREAKDOWN_NUMFMT }
    );
    r += 2;
    return r;
};

const buildSummarySheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const batch = detail.batch ?? {};
    const items: any[] = Array.isArray(detail.items) ? detail.items : [];
    const ws = workbook.addWorksheet('Tong hop', {
        pageSetup: {
            paperSize: 9,
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            horizontalCentered: true,
            margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
        },
    });
    ws.columns = [{ width: 3 }, { width: 26 }, { width: 9 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 12 }];
    ws.views = [{ showGridLines: false }];

    mergeValue(ws, 'B1:G1', 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG', {
        font: { name: FONT, size: 12, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    mergeValue(ws, 'B2:G2', 'BÁO CÁO TỔNG HỢP LÔ MÁY ĐỀ NGHỊ THANH LÝ', {
        font: { name: FONT, size: 14, bold: true, color: { argb: NAVY } },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    ws.getRow(2).height = 24;

    mergeValue(ws, 'B4:D4', `Mã lô: ${text(batch.code)}`, { font: { name: FONT, size: 10, bold: true } });
    mergeValue(ws, 'E4:G4', `Cơ sở: ${batch.plant?.name || '-'}`, { font: { name: FONT, size: 10 } });
    mergeValue(ws, 'B5:D5', `Người lập: ${batch.createdByName || batch.submittedByName || '-'}`, {
        font: { name: FONT, size: 10 },
    });
    mergeValue(ws, 'E5:G5', `Trạng thái: ${BATCH_STATUS_LABEL[batch.status] || batch.status || '-'}`, {
        font: { name: FONT, size: 10 },
    });
    mergeValue(ws, 'B6:D6', `Lý do: ${batch.reason || '-'}`, { font: { name: FONT, size: 10 } });
    mergeValue(ws, 'E6:G6', `Ngày in: ${formatDateTime(new Date())}`, {
        font: { name: FONT, size: 10, italic: true },
    });

    const totals = summarize(items);
    const assetCount = items.filter((item) => item.sourceType === 'asset').length;

    let r = 8;
    mergeValue(ws, `B${r}:G${r}`, 'CHỈ TIÊU TỔNG HỢP', {
        font: { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
        alignment: { horizontal: 'left', vertical: 'middle' },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } },
    });
    ws.getRow(r).height = 20;
    r += 1;
    putRow(ws, r, 2, ['Tổng số máy', 'Máy hệ thống', 'Máy ngoài', 'Tổng nguyên giá', 'Tổng giá chốt', '% thu hồi'], {
        bold: true,
        size: 9.5,
        fill: LIGHT,
        align: Array(6).fill('center'),
        height: 20,
    });
    r += 1;
    putRow(
        ws,
        r,
        2,
        [
            totals.count,
            assetCount,
            totals.count - assetCount,
            totals.purchase || '',
            totals.final || '',
            rateOf(totals) === '' ? '-' : (rateOf(totals) as number),
        ],
        {
            bold: true,
            size: 12,
            align: Array(6).fill('center'),
            numFmt: ['', '', '', MONEY_FMT, MONEY_FMT, PCT_FMT],
            height: 22,
        }
    );
    r += 2;

    const categoryRows = groupByType(items).map(([label, list]) => ({ label, agg: summarize(list) }));
    r = writeBreakdownTable(ws, r, 'PHÂN LOẠI THEO LOẠI MÁY', 'Loại máy', categoryRows);

    const conditionRows = CONDITION_ORDER.map(([key, label]) => ({
        label,
        list: items.filter((item) => (item.condition || 'unknown') === key),
    }))
        .filter((row) => row.list.length)
        .map((row) => ({ label: row.label, agg: summarize(row.list) }));
    r = writeBreakdownTable(ws, r, 'THEO TÌNH TRẠNG MÁY', 'Tình trạng', conditionRows);

    const actionRows = ACTION_ORDER.map(([key, label]) => ({
        label,
        list: items.filter((item) => (item.suggestedAction || 'unknown') === key),
    }))
        .filter((row) => row.list.length)
        .map((row) => ({ label: row.label, agg: summarize(row.list) }));
    r = writeBreakdownTable(ws, r, 'THEO ĐỀ XUẤT XỬ LÝ', 'Đề xuất xử lý', actionRows);

    mergeValue(
        ws,
        `B${r}:G${r + 1}`,
        'Ghi chú: Nguyên giá và % thu hồi chỉ tính trên máy có trong hệ thống và đã nhập nguyên giá. Chi tiết từng máy xem sheet "Du lieu chi tiet".',
        { font: { name: FONT, size: 9, italic: true }, alignment: { vertical: 'top', wrapText: true } }
    );

    ws.pageSetup.printArea = `A1:G${r + 1}`;
};

const buildPrintableSheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const batch = detail.batch ?? {};
    const items: any[] = Array.isArray(detail.items) ? detail.items : [];
    const summary = detail.summary ?? {};
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

    // A..H (8 cột): STT, Mã máy/QR, Tên máy(+nhãn), Model/Serial, Năm SD, Nguyên giá, Tình trạng, Đề xuất/Giá chốt
    ws.columns = [
        { width: 5 },
        { width: 16 },
        { width: 28 },
        { width: 18 },
        { width: 9 },
        { width: 15 },
        { width: 14 },
        { width: 18 },
    ];
    ws.views = [{ showGridLines: false }];

    mergeValue(ws, 'A1:E1', 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG', { font: { name: FONT, size: 11, bold: true } });
    mergeValue(ws, 'A2:E2', 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ', {
        font: { name: FONT, size: 9.5, italic: true },
    });
    mergeValue(ws, 'F1:H1', `Mã lô: ${text(batch.code)}`, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    mergeValue(ws, 'F2:H2', `Ngày in: ${formatDateTime(new Date())}`, {
        font: { name: FONT, size: 9.5, italic: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });

    mergeValue(ws, 'A4:H4', 'BIÊN BẢN RÀ SOÁT MÁY ĐỀ NGHỊ THANH LÝ', {
        font: { name: FONT, size: 15, bold: true },
        alignment: { horizontal: 'center', vertical: 'middle' },
    });
    ws.getRow(4).height = 25;

    setInfo(ws, 6, 'A6:B6', 'C6:D6', 'Cơ sở:', batch.plant?.name || '-');
    setInfo(ws, 6, 'E6:F6', 'G6:H6', 'Khu vực:', batch.area || 'Tất cả');
    setInfo(ws, 7, 'A7:B7', 'C7:D7', 'Trạng thái:', BATCH_STATUS_LABEL[batch.status] || batch.status);
    setInfo(ws, 7, 'E7:F7', 'G7:H7', 'Số máy:', summary.total ?? items.length);
    setInfo(ws, 8, 'A8:B8', 'C8:H8', 'Lý do:', batch.reason || '-');
    setInfo(ws, 9, 'A9:B9', 'C9:H9', 'Ghi chú:', batch.note || '-');
    styleRangeBorder(ws, 6, 9, 1, 8);

    const tableHeaderRow = 11;
    ws.pageSetup.printTitlesRow = `${tableHeaderRow}:${tableHeaderRow}`;
    const headers = ['STT', 'Mã máy/QR', 'Tên máy', 'Model / Serial', 'Năm SD', 'Nguyên giá', 'Tình trạng', 'Đề xuất / Giá chốt'];
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
    let counter = 0;
    const groups = items.length ? groupByType(items) : [];

    const writeItemRow = (item: any) => {
        counter += 1;
        const row = ws.getRow(rowIndex);
        row.height = 36;
        const finalValue = money(item.finalValue);
        const estimatedValue = money(item.estimatedValue);
        const actionLabel = ACTION_LABEL[item.suggestedAction] || item.suggestedAction || '-';
        const priceText = finalValue
            ? finalValue.toLocaleString('vi-VN')
            : estimatedValue
              ? `ƯT ${estimatedValue.toLocaleString('vi-VN')}`
              : '-';
        const values: Array<string | number> = [
            counter,
            codeText(item),
            nameBrandText(item),
            modelSerialText(item),
            purchaseYearText(item),
            purchasePriceCell(item),
            CONDITION_LABEL[item.condition] || item.condition || '-',
            `${actionLabel}\n${priceText}`,
        ];
        values.forEach((value, valueIndex) => {
            const current = row.getCell(valueIndex + 1);
            current.value = value as ExcelJS.CellValue;
            current.font = { name: FONT, size: 9 };
            current.border = border;
            current.alignment = {
                horizontal: valueIndex === 0 || valueIndex === 4 ? 'center' : valueIndex === 5 ? 'right' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
            if (valueIndex === 5) current.numFmt = MONEY_FMT;
        });
        rowIndex += 1;
    };

    groups.forEach(([typeName, list]) => {
        // Tiêu đề nhóm loại máy
        const headerRange = `A${rowIndex}:H${rowIndex}`;
        mergeValue(ws, headerRange, `${typeName}  (${list.length} máy)`, {
            font: { name: FONT, size: 9.5, bold: true, color: { argb: NAVY } },
            alignment: { horizontal: 'left', vertical: 'middle' },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } },
        });
        styleRangeBorder(ws, rowIndex, rowIndex, 1, 8);
        ws.getRow(rowIndex).height = 20;
        rowIndex += 1;

        list.forEach(writeItemRow);

        // Dòng cộng nhóm
        const agg = summarize(list);
        const subRow = rowIndex;
        mergeValue(ws, `A${subRow}:E${subRow}`, `Cộng ${typeName}: ${agg.count} máy`, {
            font: { name: FONT, size: 9, bold: true, italic: true },
            alignment: { horizontal: 'right', vertical: 'middle' },
        });
        const subPurchase = ws.getCell(subRow, 6);
        subPurchase.value = agg.purchase || '';
        subPurchase.numFmt = MONEY_FMT;
        subPurchase.font = { name: FONT, size: 9, bold: true };
        subPurchase.alignment = { horizontal: 'right', vertical: 'middle' };
        mergeValue(ws, `G${subRow}:H${subRow}`, agg.final ? agg.final.toLocaleString('vi-VN') : '-', {
            font: { name: FONT, size: 9, bold: true },
            alignment: { horizontal: 'right', vertical: 'middle' },
        });
        styleRangeBorder(ws, subRow, subRow, 1, 8);
        for (let col = 1; col <= 8; col += 1) {
            ws.getCell(subRow, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBTOTAL } };
        }
        rowIndex += 1;
    });

    if (!items.length) {
        writeItemRow({});
    }

    const totals = summarize(items);
    const totalRow = rowIndex;
    mergeValue(ws, `A${totalRow}:E${totalRow}`, `TỔNG CỘNG: ${totals.count} máy`, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    const totalPurchase = ws.getCell(totalRow, 6);
    totalPurchase.value = totals.purchase || '';
    totalPurchase.numFmt = MONEY_FMT;
    totalPurchase.font = { name: FONT, size: 10, bold: true };
    totalPurchase.alignment = { horizontal: 'right', vertical: 'middle' };
    mergeValue(ws, `G${totalRow}:H${totalRow}`, `${totals.final.toLocaleString('vi-VN')} đ`, {
        font: { name: FONT, size: 10, bold: true },
        alignment: { horizontal: 'right', vertical: 'middle' },
    });
    styleRangeBorder(ws, totalRow, totalRow, 1, 8);

    const recoveryRow = totalRow + 1;
    const overallRate = rateOf(totals);
    mergeValue(
        ws,
        `A${recoveryRow}:H${recoveryRow}`,
        `Tổng giá ước tính: ${totals.estimated.toLocaleString('vi-VN')} đ   |   Tổng giá chốt: ${totals.final.toLocaleString(
            'vi-VN'
        )} đ   |   Tỷ lệ thu hồi trên nguyên giá: ${overallRate === '' ? '-' : `${(overallRate * 100).toFixed(1)}%`}`,
        { font: { name: FONT, size: 9.5, bold: true }, alignment: { horizontal: 'right', vertical: 'middle' } }
    );

    const noteRow = recoveryRow + 2;
    mergeValue(
        ws,
        `A${noteRow}:H${noteRow + 1}`,
        'Ghi chú: Biên bản này dùng để rà soát, phê duyệt và lưu hồ sơ thanh lý. Máy được nhóm theo loại; thông tin chi tiết phục vụ lọc/tra cứu nằm tại sheet "Du lieu chi tiet".',
        { font: { name: FONT, size: 9, italic: true }, alignment: { vertical: 'middle', wrapText: true } }
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
            range: `G${signatureRow}:H${signatureRow}`,
            hint: `G${hintRow}:H${hintRow}`,
            name: `G${nameRow}:H${nameRow}`,
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

    ws.pageSetup.printArea = `A1:H${nameRow}`;
};

const buildDetailSheet = (workbook: ExcelJS.Workbook, detail: any) => {
    const batch = detail.batch ?? {};
    const items: any[] = Array.isArray(detail.items) ? detail.items : [];
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
        { header: 'Tên máy', key: 'name', width: 26 },
        { header: 'Nhãn hiệu', key: 'brand', width: 16 },
        { header: 'Loại (mã)', key: 'type', width: 14 },
        { header: 'Model', key: 'model', width: 16 },
        { header: 'Serial', key: 'serial', width: 16 },
        { header: 'Hình thức SH', key: 'ownership', width: 16 },
        { header: 'Nguồn', key: 'source', width: 14 },
        { header: 'Cơ sở', key: 'plant', width: 20 },
        { header: 'Khu vực', key: 'area', width: 16 },
        { header: 'Ngày mua', key: 'purchaseDate', width: 13 },
        { header: 'Tuổi (năm)', key: 'age', width: 11 },
        { header: 'Nguyên giá', key: 'purchasePrice', width: 15 },
        { header: 'Tình trạng', key: 'condition', width: 16 },
        { header: 'Đề xuất', key: 'suggestedAction', width: 16 },
        { header: 'Giá ước tính', key: 'estimatedValue', width: 14 },
        { header: 'Giá chốt', key: 'finalValue', width: 14 },
        { header: '% thu hồi', key: 'recoveryRate', width: 11 },
        { header: 'Trạng thái', key: 'status', width: 15 },
        { header: 'Người rà soát', key: 'checkedBy', width: 18 },
        { header: 'Ngày rà soát', key: 'checkedAt', width: 14 },
        { header: 'Lý do', key: 'reason', width: 24 },
        { header: 'Ghi chú', key: 'note', width: 24 },
    ];
    ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];

    const header = ws.getRow(1);
    header.height = 28;
    header.eachCell((current) => {
        current.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        current.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        current.border = border;
        current.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    });

    const sorted = [...items].sort(
        (a, b) => categoryKey(a).localeCompare(categoryKey(b), 'vi') || recoveryValue(b) - recoveryValue(a)
    );

    sorted.forEach((item, index) => {
        const price = purchasePriceCell(item);
        const rate = Number(price) > 0 ? recoveryValue(item) / Number(price) : '';
        ws.addRow({
            index: index + 1,
            batchCode: batch.code,
            code: codeText(item),
            name: nameText(item),
            brand: brandText(item),
            type: typeText(item) || '',
            model: item.model || item.asset?.model || '',
            serial: item.serial || item.asset?.serial || '',
            ownership: ownershipText(item),
            source: SOURCE_LABEL[item.sourceType] || item.sourceType,
            plant: item.plant?.name || item.asset?.plant?.name || '',
            area: item.area || item.asset?.area || '',
            purchaseDate: formatDate(purchaseDateOf(item)),
            age: ageYears(item),
            purchasePrice: price,
            condition: CONDITION_LABEL[item.condition] || item.condition || '',
            suggestedAction: ACTION_LABEL[item.suggestedAction] || item.suggestedAction || '',
            estimatedValue: money(item.estimatedValue) || '',
            finalValue: money(item.finalValue) || '',
            recoveryRate: rate,
            status: ITEM_STATUS_LABEL[item.status] || item.status,
            checkedBy: item.checkedByName || '',
            checkedAt: formatDate(item.checkedAt || item.disposedAt || item.updatedAt),
            reason: item.reason || batch.reason || '',
            note: item.note || '',
        });
    });

    // Dòng tổng cộng
    const totals = summarize(items);
    const totalRow = ws.addRow({
        name: 'TỔNG CỘNG',
        purchasePrice: totals.purchase || '',
        estimatedValue: totals.estimated || '',
        finalValue: totals.final || '',
        recoveryRate: rateOf(totals) === '' ? '' : (rateOf(totals) as number),
    });
    totalRow.font = { name: FONT, size: 10, bold: true };

    const moneyColIndex: Record<string, number> = {};
    ws.columns.forEach((col, idx) => {
        if (col.key) moneyColIndex[col.key] = idx + 1;
    });

    ws.eachRow((row, rowNumber) => {
        row.eachCell((current, colNumber) => {
            const isHeader = rowNumber === 1;
            current.font = current.font ?? { name: FONT, size: 9.5 };
            if (!isHeader) {
                current.font = { name: FONT, size: 9.5, bold: !!(current.font && current.font.bold) };
            }
            current.border = border;
            const key = (ws.columns[colNumber - 1] as any)?.key;
            const isMoney = key === 'purchasePrice' || key === 'estimatedValue' || key === 'finalValue';
            const isPct = key === 'recoveryRate';
            const isAge = key === 'age';
            current.alignment = {
                horizontal: colNumber === 1 ? 'center' : isMoney || isPct || isAge ? 'right' : 'left',
                vertical: 'middle',
                wrapText: true,
            };
            if (!isHeader) {
                if (isMoney) current.numFmt = MONEY_FMT;
                if (isPct) current.numFmt = PCT_FMT;
                if (isAge) current.numFmt = '0.0';
            }
        });
        if (rowNumber > 1) row.height = 22;
    });

    ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: ws.columns.length },
    };
};

export const generateAssetDisposalXlsx = async (detail: any): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hai Dang Management';
    workbook.created = new Date();

    buildSummarySheet(workbook, detail);
    buildPrintableSheet(workbook, detail);
    buildDetailSheet(workbook, detail);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
};
