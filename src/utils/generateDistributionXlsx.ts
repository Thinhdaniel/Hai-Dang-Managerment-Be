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
        { width: 30 },
        { width: 9 },
        { width: 12 },
        { width: 12 },
        { width: 14 },
        { width: 16 },
        { width: 8 },
        { width: 14 },
        { width: 16 },
        { width: 22 },
    ];

    ws.mergeCells('A1:D1');
    cell(ws, 'A1').value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
    cell(ws, 'A1').font = { name: FONT, size: 12, bold: true };

    ws.mergeCells('A2:D2');
    cell(ws, 'A2').value = 'Địa chỉ CS1: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
    cell(ws, 'A2').font = { name: FONT, size: 11, italic: true };

    ws.mergeCells('A4:K4');
    cell(ws, 'A4').value = 'PHIẾU CẤP PHÁT VẬT TƯ';
    cell(ws, 'A4').font = { name: FONT, size: 18, bold: true };
    cell(ws, 'A4').alignment = { horizontal: 'center', vertical: 'middle' };

    const issueDate = dayjs(distribution.distributedAt || distribution.createdAt);
    ws.mergeCells('A5:K5');
    cell(ws, 'A5').value = `Ngay ${issueDate.format('DD')} thang ${issueDate.format('MM')} nam ${issueDate.format('YYYY')}`;
    cell(ws, 'A5').font = { name: FONT, size: 11, italic: true };
    cell(ws, 'A5').alignment = { horizontal: 'center' };

    ws.mergeCells('A6:K6');
    cell(ws, 'A6').value = `So: ${distribution.distributionCode || ''}`;
    cell(ws, 'A6').font = { name: FONT, size: 11 };
    cell(ws, 'A6').alignment = { horizontal: 'center' };

    const isInternalIssue = distribution.distributionType === 'internal_issue';
    const srCode = distribution.supplyRequest?.requestCode || '';
    const fromName = distribution.fromPlant?.name || '';
    const toName = distribution.toPlant?.name || '';
    const distributedByName = distribution.distributedBy?.name || distribution.distributedBy?.email || '';
    const confirmedByName = distribution.confirmedBy?.name || distribution.confirmedBy?.email || '';
    const requesterName = distribution.requesterName || '';

    setInfo(ws, 'A8', 'B8', 'K8', isInternalIssue ? 'Loại phiếu:' : 'Căn cứ đề xuất:', isInternalIssue ? 'Cấp phát nội bộ' : srCode);
    setInfo(ws, 'A9', 'B9', 'K9', 'Xuất tại kho:', fromName);
    setInfo(
        ws,
        'A10',
        'B10',
        'K10',
        isInternalIssue ? 'Sử dụng tại:' : 'Nhập tại kho:',
        isInternalIssue ? (distribution.targetDepartment || distribution.targetLine || fromName) : toName
    );
    setInfo(ws, 'A11', 'B11', 'F11', 'Người cấp phát:', distributedByName);
    setInfo(ws, 'G11', 'H11', 'K11', isInternalIssue ? 'Người xin cấp:' : 'Người nhận:', isInternalIssue ? requesterName : confirmedByName);

    const headerRowIndex = isInternalIssue ? 14 : 13;
    if (isInternalIssue) {
        setInfo(ws, 'A12', 'B12', 'F12', 'Bộ phận:', distribution.targetDepartment || '');
        setInfo(ws, 'G12', 'H12', 'K12', 'Chuyền may:', distribution.targetLine || '');
    }

    const headers = ['STT', 'Tên vật tư', 'ĐVT', 'SL yêu cầu', 'SL thực xuất', 'Đơn giá', 'Thành tiền', 'VAT%', 'Tiền VAT', 'Tổng tiền', 'Ghi chú'];
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
        const quantityRequested = Number(item.quantityRequested ?? quantity);
        const unitPrice = Number(item.unitPrice ?? 0);
        const totalPrice = Number(item.totalPrice ?? quantity * unitPrice);
        const vatRate = Number(item.vatRate ?? 0);
        const vatAmount = Number(item.vatAmount ?? totalPrice * vatRate / 100);
        const totalWithVat = Number(item.totalWithVat ?? totalPrice + vatAmount);
        sumTotal += totalWithVat;

        const row = ws.getRow(currentRow);
        const values = [
            index + 1,
            item.materialName ?? item.material?.name ?? '---',
            item.unit ?? item.material?.unit ?? '---',
            quantityRequested,
            quantity,
            unitPrice,
            totalPrice,
            vatRate,
            vatAmount,
            totalWithVat,
            item.adjustReason ?? item.note ?? '',
        ];

        values.forEach((value, valueIndex) => {
            const currentCell = row.getCell(valueIndex + 1);
            currentCell.value = value;
            currentCell.font = { name: FONT, size: 11 };
            currentCell.border = border;

            if (valueIndex === 0) {
                currentCell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else if (valueIndex === 1 || valueIndex === 10) {
                currentCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            } else if (valueIndex === 2) {
                currentCell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else {
                currentCell.alignment = { horizontal: 'right', vertical: 'middle' };
                currentCell.numFmt = '#,##0';
            }
        });

        currentRow += 1;
    });

    ws.mergeCells(`A${currentRow}:I${currentRow}`);
    const totalLabelCell = ws.getCell(`A${currentRow}`);
    totalLabelCell.value = 'TỔNG CỘNG';
    totalLabelCell.font = { name: FONT, size: 11, bold: true };
    totalLabelCell.alignment = { horizontal: 'center', vertical: 'middle' };
    totalLabelCell.border = border;

    const totalValueCell = ws.getCell(`J${currentRow}`);
    totalValueCell.value = sumTotal;
    totalValueCell.font = { name: FONT, size: 11, bold: true };
    totalValueCell.numFmt = '#,##0';
    totalValueCell.alignment = { horizontal: 'right', vertical: 'middle' };
    totalValueCell.border = border;
    ws.getCell(`K${currentRow}`).border = border;

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
