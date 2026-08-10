import ExcelJS from 'exceljs';

export type ProductionQcOpeningResolvedEntry = {
    entryKey: string;
    lineId: string;
    lineCode: string;
    lineName?: string;
    itemId?: string;
    itemCode?: string;
    itemName?: string;
    orderCode?: string;
    unit: string;
    mode: 'full' | 'backlog_only';
    passedQuantity: number;
    defectQuantity: number;
    pendingQuantity: number;
    allocationState: 'exact' | 'unallocated';
    sourceRow?: number;
};

export type ProductionQcOpeningPreviewRow = {
    rowNumber: number;
    lineCode: string;
    itemCode?: string;
    itemName?: string;
    orderCode?: string;
    mode: 'full' | 'backlog_only';
    passedQuantity?: number;
    defectQuantity?: number;
    pendingQuantity?: number;
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

const HEADER_ALIASES = {
    lineCode: ['ma chuyen', 'chuyen', 'line', 'line code'],
    itemCode: ['ma hang', 'ma san pham', 'item', 'item code'],
    orderCode: ['ma don hang', 'don hang', 'order', 'order code'],
    mode: ['che do du lieu', 'che do', 'mode'],
    passed: ['qc dat dau ky', 'da kiem dat', 'so dat', 'passed', 'qc passed'],
    defect: ['qc loi dau ky', 'da kiem loi', 'so loi', 'defect', 'qc defect'],
    pending: ['chua kiem dau ky', 'con cho qc', 'ton cho qc', 'pending', 'qc pending'],
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

export const buildProductionQcOpeningEntryKey = (lineId: unknown, itemId?: unknown, orderCode?: unknown) =>
    `${toId(lineId).toLowerCase()}|${toId(itemId).toLowerCase()}|${normalizeCode(orderCode)}`;

const parseNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    const raw = String(value ?? '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[^\d,.-]/g, '');
    if (!raw) return 0;
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
    for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount); rowNumber += 1) {
        const headers = new Map<number, string>();
        worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
            const normalized = normalizeText(cellValue(cell.value));
            if (normalized) headers.set(column, normalized);
        });
        const lineCode = findHeaderColumn(headers, HEADER_ALIASES.lineCode);
        const pending = findHeaderColumn(headers, HEADER_ALIASES.pending);
        if (lineCode && pending) {
            return {
                rowNumber,
                columns: {
                    lineCode,
                    pending,
                    itemCode: findHeaderColumn(headers, HEADER_ALIASES.itemCode),
                    orderCode: findHeaderColumn(headers, HEADER_ALIASES.orderCode),
                    mode: findHeaderColumn(headers, HEADER_ALIASES.mode),
                    passed: findHeaderColumn(headers, HEADER_ALIASES.passed),
                    defect: findHeaderColumn(headers, HEADER_ALIASES.defect),
                },
            };
        }
    }
    return undefined;
};

const parseMode = (value: unknown): 'full' | 'backlog_only' => {
    const normalized = normalizeText(value);
    return normalized.includes('chi') && (normalized.includes('ton') || normalized.includes('cho'))
        ? 'backlog_only'
        : normalized === 'backlog only'
          ? 'backlog_only'
          : 'full';
};

export const summarizeQcOpeningEntries = (entries: ProductionQcOpeningResolvedEntry[]) => {
    const passedQuantity = entries.reduce((sum, entry) => sum + Number(entry.passedQuantity || 0), 0);
    const defectQuantity = entries.reduce((sum, entry) => sum + Number(entry.defectQuantity || 0), 0);
    const pendingQuantity = entries.reduce((sum, entry) => sum + Number(entry.pendingQuantity || 0), 0);
    const exactPendingQuantity = entries
        .filter((entry) => entry.allocationState === 'exact')
        .reduce((sum, entry) => sum + Number(entry.pendingQuantity || 0), 0);
    return {
        entryCount: entries.length,
        passedQuantity,
        defectQuantity,
        inspectedQuantity: passedQuantity + defectQuantity,
        pendingQuantity,
        exactPendingQuantity,
        unallocatedPendingQuantity: pendingQuantity - exactPendingQuantity,
        fullEntryCount: entries.filter((entry) => entry.mode === 'full').length,
    };
};

export const previewProductionQcOpeningWorkbook = async (buffer: Buffer, lines: LookupItem[], items: LookupItem[]) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(buffer) as any);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error('File Excel không có sheet dữ liệu');
    const header = findHeader(worksheet);
    if (!header) throw new Error('Không tìm thấy cột "Mã chuyền" và "Chưa kiểm đầu kỳ"');

    const lineByCode = new Map(lines.map((line) => [normalizeCode(line.code), line]));
    const itemByCode = new Map(items.map((item) => [normalizeCode(item.code), item]));
    const seen = new Set<string>();
    const rows: ProductionQcOpeningPreviewRow[] = [];
    const entries: ProductionQcOpeningResolvedEntry[] = [];

    for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const lineCode = normalizeCode(cellValue(row.getCell(header.columns.lineCode).value));
        const itemCode = header.columns.itemCode
            ? normalizeCode(cellValue(row.getCell(header.columns.itemCode).value))
            : '';
        const orderCode = header.columns.orderCode
            ? normalizeCode(cellValue(row.getCell(header.columns.orderCode).value))
            : '';
        const mode = header.columns.mode ? parseMode(cellValue(row.getCell(header.columns.mode).value)) : 'full';
        const passedQuantity = header.columns.passed
            ? parseNumber(cellValue(row.getCell(header.columns.passed).value))
            : 0;
        const defectQuantity = header.columns.defect
            ? parseNumber(cellValue(row.getCell(header.columns.defect).value))
            : 0;
        const pendingQuantity = parseNumber(cellValue(row.getCell(header.columns.pending).value));
        if (!lineCode && !itemCode && !orderCode && !passedQuantity && !defectQuantity && !pendingQuantity) continue;

        const errors: string[] = [];
        const line = lineByCode.get(lineCode);
        const item = itemCode ? itemByCode.get(itemCode) : undefined;
        if (!lineCode) errors.push('Thiếu mã chuyền');
        else if (!line) errors.push(`Không tìm thấy chuyền ${lineCode} trong cơ sở`);
        if (itemCode && !item) errors.push(`Không tìm thấy mã hàng ${itemCode} trong cơ sở`);
        if (orderCode && !itemCode) errors.push('Có mã đơn hàng nhưng chưa có mã hàng');
        if (passedQuantity === undefined || passedQuantity < 0) errors.push('Số QC đạt không hợp lệ');
        if (defectQuantity === undefined || defectQuantity < 0) errors.push('Số QC lỗi không hợp lệ');
        if (pendingQuantity === undefined || pendingQuantity < 0) errors.push('Số chưa kiểm không hợp lệ');
        if (mode === 'backlog_only' && (Number(passedQuantity) > 0 || Number(defectQuantity) > 0)) {
            errors.push('Chế độ chỉ biết tồn không nhập số đạt hoặc lỗi');
        }
        if (Number(passedQuantity) + Number(defectQuantity) + Number(pendingQuantity) <= 0) {
            errors.push('Dòng đầu kỳ phải có số lượng lớn hơn 0');
        }
        const duplicateKey = `${toId(line)}|${toId(item)}|${orderCode}`;
        if (line && seen.has(duplicateKey)) errors.push('Trùng chuyền, mã hàng và đơn hàng với dòng phía trên');
        if (!errors.length) seen.add(duplicateKey);

        const allocationState = item ? 'exact' : 'unallocated';
        rows.push({
            rowNumber,
            lineCode,
            itemCode: itemCode || undefined,
            itemName: item?.name || undefined,
            orderCode: orderCode || undefined,
            mode,
            passedQuantity,
            defectQuantity,
            pendingQuantity,
            allocationState,
            isValid: errors.length === 0,
            errors,
        });
        if (errors.length || !line || pendingQuantity === undefined) continue;
        entries.push({
            entryKey: buildProductionQcOpeningEntryKey(line, item, orderCode),
            lineId: toId(line),
            lineCode: String(line.code || lineCode),
            lineName: line.name || undefined,
            itemId: item ? toId(item) : undefined,
            itemCode: item?.code,
            itemName: item?.name || undefined,
            orderCode: orderCode || undefined,
            unit: String(item?.unit || 'SP'),
            mode,
            passedQuantity: Number(passedQuantity || 0),
            defectQuantity: Number(defectQuantity || 0),
            pendingQuantity,
            allocationState,
            sourceRow: rowNumber,
        });
    }

    const summary = summarizeQcOpeningEntries(entries);
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
