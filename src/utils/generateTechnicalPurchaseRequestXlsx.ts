import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

// Mẫu "GIẤY ĐỀ NGHỊ MUA VẬT TƯ" của bộ phận kỹ thuật — A4 nằm ngang, tối giản như biểu mẫu hành chính.
const tnr = (size = 12, bold = false, italic = false) => ({ name: 'Times New Roman' as const, size, bold, italic });

const thin = { style: 'thin' as const };
const hair = { style: 'hair' as const };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };

const AL = {
    left: { horizontal: 'left' as const, vertical: 'middle' as const },
    leftTop: { horizontal: 'left' as const, vertical: 'middle' as const, wrapText: true },
    center: { horizontal: 'center' as const, vertical: 'middle' as const },
    centerWrap: { horizontal: 'center' as const, vertical: 'middle' as const, wrapText: true },
    right: { horizontal: 'right' as const, vertical: 'middle' as const },
};

const MIN_TABLE_ROWS = 12;

export async function generateTechnicalPurchaseRequestXlsx(pr: any): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Giấy đề nghị mua vật tư', {
        pageSetup: {
            paperSize: 9, // A4
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 1,
            horizontalCentered: true,
            margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
        },
    });

    // 12 cột (A..L). Bảng 5 cột: STT(1) | Tên vật tư(2-5) | ĐVT(6) | Số lượng(7-8) | Ghi chú(9-12)
    // Khu ký 4 phần: A-C | D-F | G-I | J-L
    ws.columns = [
        { width: 5 }, // A STT
        { width: 12 }, // B \
        { width: 12 }, // C  | Tên vật tư
        { width: 11 }, // D  |
        { width: 8 }, // E  /
        { width: 7 }, // F ĐVT
        { width: 8 }, // G \ Số lượng
        { width: 8 }, // H /
        { width: 9 }, // I \
        { width: 9 }, // J  | Ghi chú
        { width: 8 }, // K  |
        { width: 8 }, // L /
    ];
    const LAST = 'L';

    const put = (ref: string, value: any, font: any, alignment: any) => {
        const c = ws.getCell(ref);
        c.value = value;
        c.font = font;
        c.alignment = alignment;
        return c;
    };
    const borderRow = (rowNum: number) => {
        for (let c = 1; c <= 12; c++) ws.getCell(rowNum, c).border = allBorders;
    };
    const bottomDots = (rowNum: number, fromCol: number, toCol: number) => {
        for (let c = fromCol; c <= toCol; c++) {
            const cell = ws.getCell(rowNum, c);
            cell.border = { ...(cell.border || {}), bottom: hair };
        }
    };

    // ── Đầu phiếu ────────────────────────────────────────────────────────────
    ws.mergeCells('A1:F1');
    put('A1', 'Công ty TNHH may Xuất Khẩu Hải Đăng', tnr(12, true), AL.left);
    ws.mergeCells('G1:L1');
    put('G1', `Số: ${pr.requestCode || ''}`, tnr(11), AL.right);

    ws.mergeCells('A2:F2');
    put('A2', 'Khu 23, Hanh Cù, Thanh Ba, Phú Thọ', tnr(11, false, true), AL.left);

    ws.getRow(3).height = 6;

    ws.mergeCells('A4:L4');
    put('A4', 'GIẤY ĐỀ NGHỊ MUA VẬT TƯ', tnr(17, true), AL.center);
    ws.getRow(4).height = 28;

    ws.getRow(5).height = 6;

    // Họ và tên / Bộ phận — căn trái, có gạch chấm để viết tay (giá trị điền sẵn nếu có)
    ws.mergeCells('A6:B6');
    put('A6', 'Họ và tên:', tnr(12), AL.left);
    ws.mergeCells('C6:L6');
    put('C6', pr.requesterName || '', tnr(12), AL.left);
    bottomDots(6, 3, 12);

    ws.mergeCells('A7:B7');
    put('A7', 'Bộ phận:', tnr(12), AL.left);
    ws.mergeCells('C7:L7');
    put('C7', pr.department || '', tnr(12), AL.left);
    bottomDots(7, 3, 12);

    ws.getRow(8).height = 6;

    // ── Bảng vật tư ──────────────────────────────────────────────────────────
    const HEADER_ROW = 9;
    ws.mergeCells(`B${HEADER_ROW}:E${HEADER_ROW}`);
    ws.mergeCells(`G${HEADER_ROW}:H${HEADER_ROW}`);
    ws.mergeCells(`I${HEADER_ROW}:L${HEADER_ROW}`);
    put(`A${HEADER_ROW}`, 'STT', tnr(12, true), AL.centerWrap);
    put(`B${HEADER_ROW}`, 'Tên vật tư', tnr(12, true), AL.centerWrap);
    put(`F${HEADER_ROW}`, 'ĐVT', tnr(12, true), AL.centerWrap);
    put(`G${HEADER_ROW}`, 'Số lượng', tnr(12, true), AL.centerWrap);
    put(`I${HEADER_ROW}`, 'Ghi chú', tnr(12, true), AL.centerWrap);
    ws.getRow(HEADER_ROW).height = 26;
    borderRow(HEADER_ROW);

    const items: any[] = Array.isArray(pr.items) ? pr.items : [];
    const totalRows = Math.max(MIN_TABLE_ROWS, items.length);
    let row = HEADER_ROW + 1;
    for (let i = 0; i < totalRows; i++) {
        const item = items[i];
        ws.mergeCells(`B${row}:E${row}`);
        ws.mergeCells(`G${row}:H${row}`);
        ws.mergeCells(`I${row}:L${row}`);

        put(`A${row}`, i + 1, tnr(12), AL.center);
        put(`B${row}`, item?.materialName ?? '', tnr(12), AL.leftTop);
        put(`F${row}`, item?.unit ?? '', tnr(12), AL.center);
        const qty = item ? item.quantityApproved ?? item.quantityRequested ?? '' : '';
        put(`G${row}`, qty, tnr(12), AL.center);
        // Ghi chú kèm máy liên quan (nếu dòng vật tư gắn máy)
        const assetLabel = item?.assetCode ? `Máy: ${item.assetCode}${item?.assetName ? ` (${item.assetName})` : ''}` : '';
        const noteText = [item?.note, assetLabel].filter(Boolean).join(' — ');
        put(`I${row}`, noteText, tnr(12), AL.leftTop);

        ws.getRow(row).height = 26;
        borderRow(row);
        row++;
    }

    // ── Khu ký tên ───────────────────────────────────────────────────────────
    ws.getRow(row).height = 8; // khoảng cách với bảng
    row++;

    // Dòng ngày tháng — chỉ ở nửa phải, phía trên P. Giám đốc / Giám Đốc
    const year = dayjs(pr.requestDate ?? pr.createdAt).year() || dayjs().year();
    ws.mergeCells(`G${row}:L${row}`);
    put(`G${row}`, `Hanh Cù, ngày ...... tháng ...... năm ${year}`, tnr(12, false, true), AL.center);
    row++;

    // Hàng chức danh: Người đề nghị | Quản Lý | P. Giám đốc | Giám Đốc
    ws.mergeCells(`A${row}:C${row}`);
    ws.mergeCells(`D${row}:F${row}`);
    ws.mergeCells(`G${row}:I${row}`);
    ws.mergeCells(`J${row}:L${row}`);
    put(`A${row}`, 'Người đề nghị', tnr(12, true), AL.center);
    put(`D${row}`, 'Quản Lý', tnr(12, true), AL.center);
    put(`G${row}`, 'P. Giám đốc', tnr(12, true), AL.center);
    put(`J${row}`, 'Giám Đốc', tnr(12, true), AL.center);
    row++;

    // Ghi chú ký
    ws.mergeCells(`A${row}:C${row}`);
    ws.mergeCells(`D${row}:F${row}`);
    ws.mergeCells(`G${row}:I${row}`);
    ws.mergeCells(`J${row}:L${row}`);
    put(`A${row}`, '(Ký, ghi rõ họ tên)', tnr(10, false, true), AL.center);
    put(`D${row}`, '(Ký, ghi rõ họ tên)', tnr(10, false, true), AL.center);
    put(`G${row}`, '(Ký, ghi rõ họ tên)', tnr(10, false, true), AL.center);
    put(`J${row}`, '(Ký, ghi rõ họ tên)', tnr(10, false, true), AL.center);
    row++;

    // Khoảng trống để ký tay
    ws.getRow(row).height = 70;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
