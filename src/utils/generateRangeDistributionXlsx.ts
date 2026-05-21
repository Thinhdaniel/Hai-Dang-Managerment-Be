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

const FULFILLMENT_LABEL: Record<string, string> = {
    fulfilled: 'Cấp đủ',
    partial: 'Cấp thiếu',
    not_supplied: 'Không cấp',
};

const INVENTORY_LABEL: Record<string, string> = {
    pending: 'Chưa trừ kho',
    applied: 'Đã trừ kho',
    skipped: 'Không theo dõi tồn',
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
 * Mỗi dòng = 1 vật tư, thông tin phiếu lặp lại trên mỗi dòng.
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
        { width: 5 },
        { width: 16 },
        { width: 15 },
        { width: 16 },
        { width: 16 },
        { width: 14 },
        { width: 18 },
        { width: 18 },
        { width: 14 },
        { width: 18 },
        { width: 18 },
        { width: 24 },
        { width: 28 },
        { width: 8 },
        { width: 10 },
        { width: 10 },
        { width: 10 },
        { width: 10 },
        { width: 14 },
        { width: 16 },
        { width: 12 },
        { width: 14 },
        { width: 7 },
        { width: 14 },
        { width: 14 },
        { width: 24 },
    ];

    // ── Row 1: Tiêu đề ────────────────────────────────────────────────────────
    ws.mergeCells('A1:Z1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    titleCell.font = { name: FONT, size: 12, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 22;

    ws.mergeCells('A2:Z2');
    const subtitleCell = ws.getCell('A2');
    subtitleCell.value = `TỔNG HỢP PHIẾU CẤP PHÁT VẬT TƯ - ${label}`;
    subtitleCell.font = { name: FONT, size: 13, bold: true };
    subtitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 26;

    // ── Row 4: Header cột ─────────────────────────────────────────────────────
    const HEADERS = [
        'STT',
        'Mã phiếu',
        'Mã đề xuất',
        'Loại',
        'Trạng thái phiếu',
        'Ngày cấp phát',
        'Kho xuất',
        'Kho nhận / Bộ phận',
        'Chuyền may',
        'Người cấp phát',
        'Người nhận',
        'Vật tư đề xuất',
        'Vật tư cấp thực tế',
        'ĐVT',
        'SL đề xuất',
        'SL duyệt',
        'SL thực cấp',
        'SL thiếu',
        'Tình trạng cấp',
        'Trạng thái kho',
        'Đơn giá',
        'Thành tiền',
        'VAT%',
        'Tiền VAT',
        'Tổng tiền',
        'Ghi chú / lý do',
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
        const loai = isInternal ? 'Nội bộ' : dist.isCompensation ? 'Cấp bù' : 'Liên cơ sở';
        const status = STATUS_LABEL[dist.status] || dist.status;
        const srCode = dist.supplyRequest?.requestCode || '';

        const items: any[] = dist.items || [];

        if (items.length === 0) {
            // Phiếu không có vật tư vẫn xuất 1 dòng
            const row = ws.getRow(rowIdx++);
            stt++;
            const vals = [
                stt, dist.distributionCode || '-', srCode, loai, status, issueDate,
                fromName, toName, targetLine, distributedBy, receiver,
                '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-',
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
            const sourceIndex = Number(item.sourceRequestItemIndex ?? 0);
            const sourceItem = dist.supplyRequest?.items?.[sourceIndex];
            const qtyOriginal = Number(sourceItem?.quantityRequested ?? item.quantityRequested ?? qty);
            const qtyApproved = Number(sourceItem?.quantityApproved ?? item.quantityRequested ?? qty);
            const qtyShortage = Number(item.quantityShortage ?? Math.max(0, qtyApproved - qty));
            const unitPrice = Number(item.unitPrice ?? 0);
            const totalPrice = Number(item.totalPrice ?? qty * unitPrice);
            const vatRate = Number(item.vatRate ?? 0);
            const vatAmount = Number(item.vatAmount ?? (totalPrice * vatRate) / 100);
            const totalWithVat = Number(item.totalWithVat ?? totalPrice + vatAmount);

            grandTotal += totalPrice;
            grandVat += vatAmount;
            grandWithVat += totalWithVat;

            const row = ws.getRow(rowIdx++);
            const vals: any[] = [
                stt,
                dist.distributionCode || '-',
                srCode,
                loai,
                status,
                issueDate,
                fromName,
                isInternal ? (dist.targetDepartment || fromName) : (dist.toPlant?.name || '-'),
                targetLine,
                distributedBy,
                receiver,
                sourceItem?.materialName || item.materialName || item.material?.name || '-',
                item.materialName || item.material?.name || '-',
                item.unit || item.material?.unit || '-',
                qtyOriginal,
                qtyApproved,
                qty,
                qtyShortage,
                FULFILLMENT_LABEL[item.fulfillmentStatus] || item.fulfillmentStatus || (qtyShortage > 0 ? 'Cấp thiếu' : 'Cấp đủ'),
                INVENTORY_LABEL[item.inventoryStatus] || item.inventoryStatus || '',
                unitPrice,
                totalPrice,
                vatRate,
                vatAmount,
                totalWithVat,
                item.adjustReason || item.note || item.inventorySkipReason || '',
            ];

            vals.forEach((v, vi) => {
                const c = row.getCell(vi + 1);
                c.value = v;
                c.font = { name: FONT, size: 11 };
                c.border = border;
                if (vi === 0) {
                    c.alignment = { horizontal: 'center', vertical: 'middle' };
                } else if (vi >= 14 && vi <= 24) {
                    c.alignment = { horizontal: 'right', vertical: 'middle' };
                    if (vi !== 18 && vi !== 19 && vi !== 22) c.numFmt = '#,##0';
                } else if ([11, 12, 18, 19, 25].includes(vi)) {
                    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
                } else {
                    c.alignment = { horizontal: 'left', vertical: 'middle' };
                }
            });
        }
    }

    // ── Dòng tổng cộng ────────────────────────────────────────────────────────
    ws.mergeCells(`A${rowIdx}:U${rowIdx}`);
    const sumLabelCell = ws.getCell(`A${rowIdx}`);
    sumLabelCell.value = 'TONG CONG';
    sumLabelCell.font = { name: FONT, size: 11, bold: true };
    sumLabelCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sumLabelCell.border = border;

    const sumData: [number, number][] = [[22, grandTotal], [24, grandVat], [25, grandWithVat]];
    sumData.forEach(([col, val]) => {
        const c = ws.getCell(rowIdx, col);
        c.value = val;
        c.font = { name: FONT, size: 11, bold: true };
        c.numFmt = '#,##0';
        c.alignment = { horizontal: 'right', vertical: 'middle' };
        c.border = border;
    });
    // Fill border cho các ô còn lại trong dòng tổng
    [23, 26].forEach((col) => { ws.getCell(rowIdx, col).border = border; });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
};
