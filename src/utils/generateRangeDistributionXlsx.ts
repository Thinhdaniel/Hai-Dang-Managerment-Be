import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const thin = { style: 'thin' as const };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const STATUS_LABEL: Record<string, string> = {
    draft: 'Nháp',
    pending: 'Chờ xuất kho',
    processing: 'Đang xử lý',
    distributed: 'Đã xuất kho',
    confirmed: 'Hoàn thành',
};

const resolveUser = (v: any): string => {
    if (!v) return '-';
    if (typeof v === 'string') return v;
    return v.name || v.email || '-';
};

/**
 * Xuất nhiều phiếu cấp phát vào 1 sheet duy nhất.
 * Mỗi dòng = 1 vật tư, thông tin phiếu lặp lại trên mỗi dòng.
 *
 * Cột:
 * STT | Mã phiếu | Loại | Ngày cấp phát | Kho xuất | Kho nhận / Bộ phận | Chuyền | Người cấp phát | Người nhận
 *   | Tên vật tư | ĐVT | SL yêu cầu | SL thực xuất | Đơn giá | Thành tiền | VAT% | Tiền VAT | Tổng tiền | Ghi chú
 */
export const generateRangeDistributionXlsx = async (
    distributions: any[],
    label: string
): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Cap phat vat tu', {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
    });

    ws.columns = [
        { width: 5 },   // A: STT
        { width: 16 },  // B: Mã phiếu
        { width: 12 },  // C: Loại
        { width: 14 },  // D: Ngày cấp phát
        { width: 18 },  // E: Kho xuất
        { width: 18 },  // F: Kho nhận / Bộ phận
        { width: 14 },  // G: Chuyền
        { width: 18 },  // H: Người cấp phát
        { width: 18 },  // I: Người nhận
        { width: 26 },  // J: Tên vật tư
        { width: 8 },   // K: ĐVT
        { width: 10 },  // L: SL yêu cầu
        { width: 10 },  // M: SL thực xuất
        { width: 12 },  // N: Đơn giá
        { width: 14 },  // O: Thành tiền
        { width: 7 },   // P: VAT%
        { width: 14 },  // Q: Tiền VAT
        { width: 14 },  // R: Tổng tiền
        { width: 20 },  // S: Ghi chú
    ];

    // ── Row 1: Tiêu đề ────────────────────────────────────────────────────────
    ws.mergeCells('A1:S1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    titleCell.font = { name: FONT, size: 12, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 22;

    ws.mergeCells('A2:S2');
    const subtitleCell = ws.getCell('A2');
    subtitleCell.value = `TỔNG HỢP PHIẾU CẤP PHÁT VẬT TƯ - ${label}`;
    subtitleCell.font = { name: FONT, size: 13, bold: true };
    subtitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 26;

    // ── Row 4: Header cột ─────────────────────────────────────────────────────
    const HEADERS = [
        'STT', 'Mã phiếu', 'Loại', 'Ngày cấp phát',
        'Kho xuất', 'Kho nhận / Bộ phận', 'Chuyền may',
        'Người cấp phát', 'Người nhận',
        'Tên vật tư', 'ĐVT', 'SL yêu cầu', 'SL thực xuất',
        'Đơn giá', 'Thành tiền', 'VAT%', 'Tiền VAT', 'Tổng tiền', 'Ghi chú',
    ];
    const headerRow = ws.getRow(4);
    headerRow.height = 30;
    HEADERS.forEach((h, i) => {
        const c = headerRow.getCell(i + 1);
        c.value = h;
        c.font = { name: FONT, size: 11, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.border = border;
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    });

    // ── Dữ liệu ───────────────────────────────────────────────────────────────
    let rowIdx = 5;
    let stt = 0;
    let grandTotal = 0;
    let grandVat = 0;
    let grandWithVat = 0;

    for (const dist of distributions) {
        const isInternal = dist.distributionType === 'internal_issue';
        const issueDate = dayjs(dist.distributedAt || dist.createdAt).format('DD/MM/YYYY');
        const fromName = dist.fromPlant?.name || '-';
        const toName = isInternal
            ? [dist.targetDepartment, dist.targetLine].filter(Boolean).join(' / ') || fromName
            : (dist.toPlant?.name || '-');
        const targetLine = isInternal ? (dist.targetLine || '-') : '-';
        const distributedBy = resolveUser(dist.distributedBy);
        // Người nhận: liên cơ sở = confirmedBy, nội bộ = requesterName
        const receiver = isInternal
            ? (dist.requesterName || '-')
            : resolveUser(dist.confirmedBy);
        const loai = isInternal ? 'Nội bộ' : 'Liên cơ sở';
        const status = STATUS_LABEL[dist.status] || dist.status;

        const items: any[] = dist.items || [];

        if (items.length === 0) {
            // Phiếu không có vật tư vẫn xuất 1 dòng
            const row = ws.getRow(rowIdx++);
            stt++;
            const vals = [
                stt, dist.distributionCode || '-', loai, issueDate,
                fromName, toName, targetLine, distributedBy, receiver,
                '-', '-', '-', '-', '-', '-', '-', '-', '-', status,
            ];
            vals.forEach((v, vi) => {
                const c = row.getCell(vi + 1);
                c.value = v;
                c.font = { name: FONT, size: 11 };
                c.border = border;
                c.alignment = { horizontal: vi === 0 ? 'center' : 'left', vertical: 'middle' };
            });
            continue;
        }

        for (const item of items) {
            stt++;
            const qty = Number(item.quantity ?? 0);
            const qtyReq = Number(item.quantityRequested ?? qty);
            const unitPrice = Number(item.unitPrice ?? 0);
            const totalPrice = Number(item.totalPrice ?? qty * unitPrice);
            const vatRate = Number(item.vatRate ?? 0);
            const vatAmount = Number(item.vatAmount ?? totalPrice * vatRate / 100);
            const totalWithVat = Number(item.totalWithVat ?? totalPrice + vatAmount);

            grandTotal += totalPrice;
            grandVat += vatAmount;
            grandWithVat += totalWithVat;

            const row = ws.getRow(rowIdx++);
            const vals: any[] = [
                stt,
                dist.distributionCode || '-',
                loai,
                issueDate,
                fromName,
                isInternal ? (dist.targetDepartment || fromName) : (dist.toPlant?.name || '-'),
                targetLine,
                distributedBy,
                receiver,
                item.materialName || item.material?.name || '-',
                item.unit || item.material?.unit || '-',
                qtyReq,
                qty,
                unitPrice,
                totalPrice,
                vatRate,
                vatAmount,
                totalWithVat,
                item.adjustReason || item.note || '',
            ];

            vals.forEach((v, vi) => {
                const c = row.getCell(vi + 1);
                c.value = v;
                c.font = { name: FONT, size: 11 };
                c.border = border;
                // Căn phải các cột số: L(11), M(12), N(13), O(14), P(15), Q(16), R(17)
                if (vi === 0) {
                    c.alignment = { horizontal: 'center', vertical: 'middle' };
                } else if (vi >= 11 && vi <= 17) {
                    c.alignment = { horizontal: 'right', vertical: 'middle' };
                    if (vi !== 15) c.numFmt = '#,##0'; // VAT% không format tiền
                } else if (vi === 9 || vi === 18) {
                    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
                } else {
                    c.alignment = { horizontal: 'left', vertical: 'middle' };
                }
            });
        }
    }

    // ── Dòng tổng cộng ────────────────────────────────────────────────────────
    ws.mergeCells(`A${rowIdx}:N${rowIdx}`);
    const sumLabelCell = ws.getCell(`A${rowIdx}`);
    sumLabelCell.value = 'TONG CONG';
    sumLabelCell.font = { name: FONT, size: 11, bold: true };
    sumLabelCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sumLabelCell.border = border;

    const sumData: [number, number][] = [[15, grandTotal], [17, grandVat], [18, grandWithVat]];
    sumData.forEach(([col, val]) => {
        const c = ws.getCell(rowIdx, col);
        c.value = val;
        c.font = { name: FONT, size: 11, bold: true };
        c.numFmt = '#,##0';
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        c.border = border;
    });
    // Fill border cho các ô còn lại trong dòng tổng
    [16, 19].forEach((col) => { ws.getCell(rowIdx, col).border = border; });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
};
