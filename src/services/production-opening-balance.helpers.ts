import ExcelJS from 'exceljs';

export type ProductionOpeningBalanceResolvedEntry = {
    entryKey: string;
    lineId: string;
    lineCode: string;
    lineName?: string;
    itemId?: string;
    itemCode?: string;
    itemName?: string;
    orderCode?: string;
    unit: string;
    quantity: number;
    unitPriceSnapshot?: number;
    amountSnapshot?: number;
    allocationState: 'exact' | 'unallocated';
    sourceRow?: number;
};

export type ProductionOpeningBalancePreviewRow = {
    rowNumber: number;
    lineCode: string;
    itemCode?: string;
    orderCode?: string;
    quantity?: number;
    unitPrice?: number;
    unit?: string;
    lineName?: string;
    itemName?: string;
    allocationState: 'exact' | 'unallocated';
    isValid: boolean;
    errors: string[];
};

type LookupItem = {
    _id?: unknown;
    id?: unknown;
    code?: string;
    name?: string | null;
    unit?: string | null;
};

type WorkbookPreview = {
    sheetName: string;
    headerRow: number;
    rows: ProductionOpeningBalancePreviewRow[];
    entries: ProductionOpeningBalanceResolvedEntry[];
    summary: ReturnType<typeof summarizeOpeningBalanceEntries> & {
        totalRows: number;
        validRows: number;
        invalidRows: number;
    };
};

const HEADER_ALIASES = {
    lineCode: ['ma chuyen', 'chuyen', 'chuyen may', 'line', 'line code', 'linecode'],
    itemCode: ['ma hang', 'ma san pham', 'item', 'item code', 'itemcode'],
    orderCode: ['ma don hang', 'don hang', 'order', 'order code', 'ordercode'],
    quantity: [
        'san luong dau ky',
        'tong san truoc',
        'tong san truoc he thong',
        'luy ke truoc',
        'luy ke dau ky',
        'so luong',
        'san luong',
        'opening quantity',
        'openingquantity',
    ],
    unit: ['dvt', 'don vi', 'don vi tinh', 'unit'],
    unitPrice: [
        'don gia',
        'don gia lich su',
        'gia',
        'unit price',
        'historical unit price',
        'unitprice',
    ],
} as const;

const toId = (value: unknown) => String((value as any)?._id ?? (value as any)?.id ?? value ?? '');

const cellValue = (value: ExcelJS.CellValue | null | undefined): unknown => {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return value;
    if ('result' in value && value.result !== undefined) return cellValue(value.result as ExcelJS.CellValue);
    if ('text' in value && value.text !== undefined) return value.text;
    if ('richText' in value && Array.isArray(value.richText)) {
        return value.richText.map((part) => part.text).join('');
    }
    return String(value);
};

const normalizeText = (value: unknown) =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/[*():/_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const normalizeCode = (value: unknown) =>
    String(value ?? '')
        .trim()
        .toUpperCase();

export const buildProductionOpeningBalanceEntryKey = (
    lineId: unknown,
    itemId?: unknown,
    orderCode?: unknown
) =>
    `${toId(lineId).toLowerCase()}|${toId(itemId).toLowerCase()}|${normalizeCode(orderCode)}`;

const parseNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    const raw = String(value ?? '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[^\d,.-]/g, '');
    if (!raw) return undefined;
    const normalized = /^-?\d{1,3}([.,]\d{3})+$/.test(raw)
        ? raw.replace(/[.,]/g, '')
        : raw.includes(',') && !raw.includes('.')
          ? raw.replace(',', '.')
          : raw.replace(/,/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const findHeaderColumn = (headers: Map<number, string>, aliases: readonly string[]) => {
    const normalizedAliases = aliases.map(normalizeText);
    for (const [column, header] of headers.entries()) {
        if (normalizedAliases.includes(header)) return column;
    }
    return undefined;
};

const findHeader = (worksheet: ExcelJS.Worksheet) => {
    const maxRows = Math.min(20, Math.max(1, worksheet.rowCount));
    for (let rowNumber = 1; rowNumber <= maxRows; rowNumber += 1) {
        const headers = new Map<number, string>();
        worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
            const normalized = normalizeText(cellValue(cell.value));
            if (normalized) headers.set(column, normalized);
        });
        const lineCode = findHeaderColumn(headers, HEADER_ALIASES.lineCode);
        const quantity = findHeaderColumn(headers, HEADER_ALIASES.quantity);
        if (lineCode && quantity) {
            return {
                rowNumber,
                columns: {
                    lineCode,
                    quantity,
                    itemCode: findHeaderColumn(headers, HEADER_ALIASES.itemCode),
                    orderCode: findHeaderColumn(headers, HEADER_ALIASES.orderCode),
                    unit: findHeaderColumn(headers, HEADER_ALIASES.unit),
                    unitPrice: findHeaderColumn(headers, HEADER_ALIASES.unitPrice),
                },
            };
        }
    }
    return undefined;
};

export const summarizeOpeningBalanceEntries = (entries: ProductionOpeningBalanceResolvedEntry[]) => {
    const totalQuantity = entries.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    const exactQuantity = entries
        .filter((entry) => entry.allocationState === 'exact')
        .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    const valuedQuantity = entries
        .filter((entry) => entry.amountSnapshot !== undefined)
        .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    const totalAmount = entries.reduce((sum, entry) => sum + Number(entry.amountSnapshot || 0), 0);
    return {
        entryCount: entries.length,
        totalQuantity,
        exactQuantity,
        unallocatedQuantity: totalQuantity - exactQuantity,
        valuedQuantity,
        totalAmount,
    };
};

export const previewProductionOpeningBalanceWorkbook = async (
    buffer: Buffer,
    lines: LookupItem[],
    items: LookupItem[]
): Promise<WorkbookPreview> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(buffer) as any);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error('File Excel không có sheet dữ liệu');
    const header = findHeader(worksheet);
    if (!header) {
        throw new Error('Không tìm thấy cột "Mã chuyền" và "Sản lượng đầu kỳ" trong 20 dòng đầu');
    }

    const lineByCode = new Map(lines.map((line) => [normalizeCode(line.code), line]));
    const itemByCode = new Map(items.map((item) => [normalizeCode(item.code), item]));
    const seenKeys = new Set<string>();
    const rows: ProductionOpeningBalancePreviewRow[] = [];
    const entries: ProductionOpeningBalanceResolvedEntry[] = [];

    for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const lineCode = normalizeCode(cellValue(row.getCell(header.columns.lineCode).value));
        const rawQuantity = cellValue(row.getCell(header.columns.quantity).value);
        const itemCode = header.columns.itemCode
            ? normalizeCode(cellValue(row.getCell(header.columns.itemCode).value))
            : '';
        const orderCode = header.columns.orderCode
            ? String(cellValue(row.getCell(header.columns.orderCode).value) ?? '').trim()
            : '';
        const unit = header.columns.unit
            ? String(cellValue(row.getCell(header.columns.unit).value) ?? '').trim()
            : '';
        const unitPrice = header.columns.unitPrice
            ? parseNumber(cellValue(row.getCell(header.columns.unitPrice).value))
            : undefined;
        const quantity = parseNumber(rawQuantity);

        if (!lineCode && !itemCode && quantity === undefined && !orderCode) continue;

        const errors: string[] = [];
        const line = lineByCode.get(lineCode);
        const item = itemCode ? itemByCode.get(itemCode) : undefined;
        if (!lineCode) errors.push('Thiếu mã chuyền');
        else if (!line) errors.push(`Không tìm thấy chuyền ${lineCode} trong cơ sở`);
        if (itemCode && !item) errors.push(`Không tìm thấy mã hàng ${itemCode} trong cơ sở`);
        if (orderCode && !itemCode) errors.push('Có mã đơn hàng nhưng chưa có mã hàng');
        if (quantity === undefined || quantity <= 0) errors.push('Sản lượng đầu kỳ phải lớn hơn 0');
        if (unitPrice !== undefined && unitPrice < 0) errors.push('Đơn giá không hợp lệ');

        const duplicateKey = `${toId(line)}|${toId(item)}|${normalizeCode(orderCode)}`;
        if (line && quantity !== undefined && quantity > 0 && seenKeys.has(duplicateKey)) {
            errors.push('Trùng chuyền, mã hàng và đơn hàng với một dòng phía trên');
        }
        if (!errors.length) seenKeys.add(duplicateKey);

        const allocationState = item ? 'exact' : 'unallocated';
        const previewRow: ProductionOpeningBalancePreviewRow = {
            rowNumber,
            lineCode,
            itemCode: itemCode || undefined,
            orderCode: orderCode || undefined,
            quantity,
            unitPrice,
            unit: unit || String(item?.unit || 'SP'),
            lineName: line?.name || undefined,
            itemName: item?.name || undefined,
            allocationState,
            isValid: errors.length === 0,
            errors,
        };
        rows.push(previewRow);

        if (!previewRow.isValid || !line || quantity === undefined) continue;
        const resolvedUnitPrice = unitPrice;
        entries.push({
            entryKey: buildProductionOpeningBalanceEntryKey(line, item, orderCode),
            lineId: toId(line),
            lineCode: String(line.code || lineCode),
            lineName: line.name || undefined,
            itemId: item ? toId(item) : undefined,
            itemCode: item?.code,
            itemName: item?.name || undefined,
            orderCode: orderCode || undefined,
            unit: unit || String(item?.unit || 'SP'),
            quantity,
            unitPriceSnapshot: resolvedUnitPrice,
            amountSnapshot: resolvedUnitPrice !== undefined ? quantity * resolvedUnitPrice : undefined,
            allocationState,
            sourceRow: rowNumber,
        });
    }

    const summary = summarizeOpeningBalanceEntries(entries);
    return {
        sheetName: worksheet.name,
        headerRow: header.rowNumber,
        rows,
        entries,
        summary: {
            ...summary,
            totalRows: rows.length,
            validRows: entries.length,
            invalidRows: rows.length - entries.length,
        },
    };
};
