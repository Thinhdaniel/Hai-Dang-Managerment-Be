import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const FONT = 'Times New Roman';
const thin = { style: 'thin' as const };
const border = { top: thin, left: thin, bottom: thin, right: thin };

const cell = (ws: ExcelJS.Worksheet, addr: string) => ws.getCell(addr);

const setInfo = (
    ws: ExcelJS.Worksheet,
    labelCell: string,
    valueStart: string,
    valueEnd: string,
    label: string,
    value: string
) => {
    cell(ws, labelCell).value = label;
    cell(ws, labelCell).font = { name: FONT, size: 11 };
    ws.mergeCells(`${valueStart}:${valueEnd}`);
    cell(ws, valueStart).value = value;
    cell(ws, valueStart).font = { name: FONT, size: 11, bold: true };
};

const STATUS_LABEL: Record<string, string> = {
    draft: 'Nháp',
    pending: 'Chờ xuất kho',
    processing: 'Đang xử lý',
    distributed: 'Đã xuất kho - chờ nhận',
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

const resolveUser = (value: any) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.name || value.fullname || value.email || '';
};

const getSourceRequestItem = (distribution: any, item: any, index: number) => {
    const sourceIndex = Number(item.sourceRequestItemIndex ?? index);
    return distribution.supplyRequest?.items?.[sourceIndex];
};

export const generateDistributionXlsx = async (distribution: any): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Phieu cap phat', {
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
    });

    ws.columns = [
        { width: 6 },
        { width: 26 },
        { width: 30 },
        { width: 9 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 14 },
        { width: 16 },
        { width: 14 },
        { width: 16 },
        { width: 8 },
        { width: 14 },
        { width: 16 },
        { width: 26 },
    ];

    ws.mergeCells('A1:D1');
    cell(ws, 'A1').value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    cell(ws, 'A1').font = { name: FONT, size: 12, bold: true };

    ws.mergeCells('A2:D2');
    cell(ws, 'A2').value = 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
    cell(ws, 'A2').font = { name: FONT, size: 11, italic: true };

    ws.mergeCells('A4:P4');
    cell(ws, 'A4').value = 'PHIẾU CẤP PHÁT VẬT TƯ';
    cell(ws, 'A4').font = { name: FONT, size: 18, bold: true };
    cell(ws, 'A4').alignment = { horizontal: 'center', vertical: 'middle' };

    const issueDate = dayjs(distribution.distributedAt || distribution.createdAt);
    ws.mergeCells('A5:P5');
    cell(ws, 'A5').value = `Ngay ${issueDate.format('DD')} thang ${issueDate.format('MM')} nam ${issueDate.format('YYYY')}`;
    cell(ws, 'A5').font = { name: FONT, size: 11, italic: true };
    cell(ws, 'A5').alignment = { horizontal: 'center' };

    ws.mergeCells('A6:P6');
    cell(ws, 'A6').value = `Số: ${distribution.distributionCode || ''}`;
    cell(ws, 'A6').font = { name: FONT, size: 11 };
    cell(ws, 'A6').alignment = { horizontal: 'center' };

    const isInternalIssue = distribution.distributionType === 'internal_issue';
    const isCompensation = distribution.isCompensation === true;
    const srCode = distribution.supplyRequest?.requestCode || '';
    const fromName = distribution.fromPlant?.name || '';
    const toName = distribution.toPlant?.name || '';
    const distributedByName = resolveUser(distribution.distributedBy);
    const confirmedByName = resolveUser(distribution.confirmedBy);
    const requesterName = distribution.requesterName || '';
    const statusLabel = STATUS_LABEL[distribution.status] || distribution.status || '';
    const typeLabel = isInternalIssue ? 'Cấp phát nội bộ' : isCompensation ? 'Cấp bù vật tư' : 'Cấp phát liên cơ sở';

    setInfo(ws, 'A8', 'B8', 'H8', 'Loại phiếu:', typeLabel);
    setInfo(ws, 'I8', 'J8', 'P8', 'Trạng thái:', statusLabel);
    setInfo(ws, 'A9', 'B9', 'H9', isInternalIssue ? 'Mục đích:' : 'Căn cứ đề xuất:', isInternalIssue ? (distribution.note || '') : srCode);
    setInfo(ws, 'I9', 'J9', 'P9', 'Ngày tạo:', distribution.createdAt ? dayjs(distribution.createdAt).format('DD/MM/YYYY HH:mm') : '');
    setInfo(ws, 'A10', 'B10', 'H10', 'Xuất tại kho:', fromName);
    setInfo(
        ws,
        'I10',
        'J10',
        'P10',
        isInternalIssue ? 'Sử dụng tại:' : 'Nhập tại kho:',
        isInternalIssue ? (distribution.targetDepartment || distribution.targetLine || fromName) : toName
    );
    setInfo(ws, 'A11', 'B11', 'H11', 'Người cấp phát:', distributedByName);
    setInfo(ws, 'I11', 'J11', 'P11', isInternalIssue ? 'Người xin cấp:' : 'Người nhận:', isInternalIssue ? requesterName : confirmedByName);

    const headerRowIndex = isInternalIssue ? 15 : 13;
    if (isInternalIssue) {
        setInfo(ws, 'A12', 'B12', 'H12', 'Bộ phận:', distribution.targetDepartment || '');
        setInfo(ws, 'I12', 'J12', 'P12', 'Chuyền may:', distribution.targetLine || '');
    } else if (distribution.note) {
        setInfo(ws, 'A12', 'B12', 'P12', 'Ghi chú phiếu:', distribution.note || '');
    }

    const headers = [
        'STT',
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
    const headerRow = ws.getRow(headerRowIndex);
    headerRow.height = 28;

    headers.forEach((value, index) => {
        const currentCell = headerRow.getCell(index + 1);
        currentCell.value = value;
        currentCell.font = { name: FONT, size: 11, bold: true };
        currentCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        currentCell.border = border;
        currentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    });

    const items: any[] = distribution.items || [];
    let currentRow = headerRowIndex + 1;
    let sumTotal = 0;

    items.forEach((item, index) => {
        const quantity = Number(item.quantity ?? 0);
        const sourceItem = getSourceRequestItem(distribution, item, index);
        const quantityOriginal = Number(sourceItem?.quantityRequested ?? item.quantityRequested ?? quantity);
        const quantityApproved = Number(sourceItem?.quantityApproved ?? item.quantityRequested ?? quantity);
        const quantityShortage = Number(item.quantityShortage ?? Math.max(0, quantityApproved - quantity));
        const unitPrice = Number(item.unitPrice ?? 0);
        const totalPrice = Number(item.totalPrice ?? quantity * unitPrice);
        const vatRate = Number(item.vatRate ?? 0);
        const vatAmount = Number(item.vatAmount ?? (totalPrice * vatRate) / 100);
        const totalWithVat = Number(item.totalWithVat ?? totalPrice + vatAmount);
        sumTotal += totalWithVat;

        const row = ws.getRow(currentRow);
        const values = [
            index + 1,
            sourceItem?.materialName ?? item.materialName ?? item.material?.name ?? '---',
            item.materialName ?? item.material?.name ?? '---',
            item.unit ?? item.material?.unit ?? '---',
            quantityOriginal,
            quantityApproved,
            quantity,
            quantityShortage,
            FULFILLMENT_LABEL[item.fulfillmentStatus] || item.fulfillmentStatus || (quantityShortage > 0 ? 'Cấp thiếu' : 'Cấp đủ'),
            INVENTORY_LABEL[item.inventoryStatus] || item.inventoryStatus || '',
            unitPrice,
            totalPrice,
            vatRate,
            vatAmount,
            totalWithVat,
            item.adjustReason ?? item.note ?? item.inventorySkipReason ?? '',
        ];

        values.forEach((value, valueIndex) => {
            const currentCell = row.getCell(valueIndex + 1);
            currentCell.value = value;
            currentCell.font = { name: FONT, size: 11 };
            currentCell.border = border;

            if (valueIndex === 0) {
                currentCell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else if (valueIndex === 1 || valueIndex === 2 || valueIndex === 8 || valueIndex === 9 || valueIndex === 15) {
                currentCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            } else if (valueIndex === 3) {
                currentCell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else if (valueIndex >= 4 && valueIndex <= 14) {
                currentCell.alignment = { horizontal: 'right', vertical: 'middle' };
                if (valueIndex !== 8 && valueIndex !== 9 && valueIndex !== 12) currentCell.numFmt = '#,##0';
            } else {
                currentCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            }
        });

        currentRow += 1;
    });

    ws.mergeCells(`A${currentRow}:N${currentRow}`);
    const totalLabelCell = ws.getCell(`A${currentRow}`);
    totalLabelCell.value = 'TỔNG CỘNG';
    totalLabelCell.font = { name: FONT, size: 11, bold: true };
    totalLabelCell.alignment = { horizontal: 'center', vertical: 'middle' };
    totalLabelCell.border = border;

    const totalValueCell = ws.getCell(`O${currentRow}`);
    totalValueCell.value = sumTotal;
    totalValueCell.font = { name: FONT, size: 11, bold: true };
    totalValueCell.numFmt = '#,##0';
    totalValueCell.alignment = { horizontal: 'right', vertical: 'middle' };
    totalValueCell.border = border;
    ws.getCell(`P${currentRow}`).border = border;

    if (Array.isArray(distribution.supplyShortages) && distribution.supplyShortages.length > 0) {
        currentRow += 2;
        ws.mergeCells(`A${currentRow}:P${currentRow}`);
        cell(ws, `A${currentRow}`).value = 'DANH SÁCH VẬT TƯ CÒN THIẾU / CẤP BÙ';
        cell(ws, `A${currentRow}`).font = { name: FONT, size: 12, bold: true };
        cell(ws, `A${currentRow}`).alignment = { horizontal: 'center' };

        currentRow += 1;
        const shortageHeaders = ['STT', 'Vật tư', 'ĐVT', 'SL duyệt', 'SL đã cấp', 'SL thiếu', 'Đã cấp bù', 'Còn phải cấp bù', 'Trạng thái', 'Lý do'];
        shortageHeaders.forEach((value, index) => {
            const currentCell = ws.getRow(currentRow).getCell(index + 1);
            currentCell.value = value;
            currentCell.font = { name: FONT, size: 11, bold: true };
            currentCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            currentCell.border = border;
            currentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
        });

        distribution.supplyShortages.forEach((shortage: any, index: number) => {
            currentRow += 1;
            const shortageQty = Number(shortage.quantityShortage ?? 0);
            const resolvedQty = Number(shortage.quantityResolved ?? 0);
            const row = ws.getRow(currentRow);
            const values = [
                index + 1,
                shortage.materialName || '',
                shortage.unit || '',
                shortage.quantityRequested ?? '',
                shortage.quantityDistributed ?? '',
                shortageQty,
                resolvedQty,
                Math.max(0, shortageQty - resolvedQty),
                shortage.status || '',
                shortage.reason || shortage.note || '',
            ];

            values.forEach((value, valueIndex) => {
                const currentCell = row.getCell(valueIndex + 1);
                currentCell.value = value;
                currentCell.font = { name: FONT, size: 11 };
                currentCell.border = border;
                currentCell.alignment =
                    valueIndex === 0
                        ? { horizontal: 'center', vertical: 'middle' }
                        : valueIndex >= 3 && valueIndex <= 7
                          ? { horizontal: 'right', vertical: 'middle' }
                          : { horizontal: 'left', vertical: 'middle', wrapText: true };
                if (valueIndex >= 3 && valueIndex <= 7) currentCell.numFmt = '#,##0';
            });
        });
    }

    const signatureRow = currentRow + 2;
    const signatureNameRow = signatureRow + 4;

    const setSignature = (column: string, label: string, value: string) => {
        cell(ws, `${column}${signatureRow}`).value = label;
        cell(ws, `${column}${signatureRow}`).font = { name: FONT, size: 11, bold: true };
        cell(ws, `${column}${signatureRow}`).alignment = { horizontal: 'center' };
        cell(ws, `${column}${signatureNameRow}`).value = value;
        cell(ws, `${column}${signatureNameRow}`).font = { name: FONT, size: 11 };
        cell(ws, `${column}${signatureNameRow}`).alignment = { horizontal: 'center' };
    };

    setSignature('B', 'Người lập phiếu', '');
    setSignature('F', isInternalIssue ? 'Người xin cấp' : 'Người nhận hàng', isInternalIssue ? requesterName : confirmedByName);
    setSignature('J', 'Thủ kho xuất', distributedByName);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
};
