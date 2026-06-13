import ExcelJS from 'exceljs';
import dayjs from 'dayjs';

const thin = { style: 'thin' as const };
const medium = { style: 'medium' as const };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
const tnr = (size = 11, bold = false, italic = false) => ({
    name: 'Times New Roman' as const,
    size,
    bold,
    italic,
});

const HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFEAF2FD' } };
const BRAND_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFDBEAFE' } };
const WARNING_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFF7ED' } };

const TYPE_LABEL: Record<string, string> = {
    periodic: 'Bảo trì định kỳ',
    emergency: 'Sửa chữa đột xuất',
    inspection: 'Kiểm tra',
};
const STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ xử lý',
    in_progress: 'Đang thực hiện',
    completed: 'Hoàn thành',
    overdue: 'Quá hạn',
    cancelled: 'Đã hủy',
};
const APPROVAL_LABEL: Record<string, string> = {
    none: '—',
    pending: 'Chờ duyệt',
    approved: 'Đã duyệt',
    rejected: 'Từ chối',
};

const buildCode = (m: any) => {
    const base = m?.createdAt || m?.startDate || new Date();
    const year = dayjs(base).year();
    return `MNT-${year}-${String(m?.id ?? '')
        .slice(-5)
        .toUpperCase()}`;
};

const fmtDate = (value?: string) => (value ? dayjs(value).format('DD/MM/YYYY') : '—');
const fmtDateTime = (value?: string) => (value ? dayjs(value).format('HH:mm DD/MM/YYYY') : dayjs().format('HH:mm DD/MM/YYYY'));
const fmtMoney = (value?: number) => {
    const amount = Number(value ?? 0);
    return amount ? `${amount.toLocaleString('vi-VN')} đ` : '—';
};
const compactText = (...parts: Array<string | undefined | null>) => parts.filter(Boolean).join(' - ') || '—';

export async function generateMaintenanceXlsx(m: any): Promise<Buffer> {
    const isExternal = (m?.repairMode ?? 'internal') === 'external';
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hai Dang Management';
    workbook.created = new Date();

    const ws = workbook.addWorksheet(isExternal ? 'Phiếu xuất máy sửa ngoài' : 'Phiếu bảo trì', {
        pageSetup: {
            paperSize: 9,
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            margins: { left: 0.35, right: 0.35, top: 0.35, bottom: 0.35, header: 0.2, footer: 0.2 },
        },
        views: [{ showGridLines: false }],
    });

    ws.columns = [
        { width: 6 },
        { width: 15 },
        { width: 24 },
        { width: 15 },
        { width: 18 },
        { width: 18 },
        { width: 20 },
    ];

    const LAST = 'G';
    const COLS = 7;
    const code = buildCode(m);
    const assets: any[] = Array.isArray(m?.assets) && m.assets.length ? m.assets : m?.asset ? [m.asset] : [];
    const ext = m?.externalRepair ?? {};

    let row = 1;

    const applyOutline = (from: number, to: number) => {
        for (let r = from; r <= to; r++) {
            for (let c = 1; c <= COLS; c++) {
                ws.getCell(r, c).border = allBorders;
            }
        }
    };

    const merge = (range: string, value: string, font = tnr(), alignment: Partial<ExcelJS.Alignment> = {}) => {
        ws.mergeCells(range);
        const cell = ws.getCell(range.split(':')[0]);
        cell.value = value;
        cell.font = font;
        cell.alignment = { vertical: 'middle', wrapText: true, ...alignment };
        return cell;
    };

    const infoRow = (label: string, value: string, fill?: ExcelJS.Fill) => {
        const current = row;
        ws.mergeCells(`A${row}:B${row}`);
        const labelCell = ws.getCell(`A${row}`);
        labelCell.value = label;
        labelCell.font = tnr(11, true);
        labelCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

        ws.mergeCells(`C${row}:${LAST}${row}`);
        const valueCell = ws.getCell(`C${row}`);
        valueCell.value = value;
        valueCell.font = tnr(11);
        valueCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

        if (fill) {
            for (let c = 1; c <= COLS; c++) ws.getCell(row, c).fill = fill;
        }
        applyOutline(current, current);
        ws.getRow(row).height = Math.max(22, Math.ceil(String(value).length / 80) * 18);
        row++;
    };

    const renderHeader = (copyLabel?: string) => {
        const start = row;
        ws.mergeCells(`A${row}:D${row}`);
        const company = ws.getCell(`A${row}`);
        company.value = 'CÔNG TY TNHH MAY XUẤT KHẨU HẢI ĐĂNG';
        company.font = tnr(12, true);
        company.alignment = { horizontal: 'left', vertical: 'middle' };

        ws.mergeCells(`E${row}:${LAST}${row}`);
        const codeCell = ws.getCell(`E${row}`);
        codeCell.value = `Số phiếu: ${code}`;
        codeCell.font = tnr(11, true);
        codeCell.alignment = { horizontal: 'right', vertical: 'middle' };
        row++;

        ws.mergeCells(`A${row}:${LAST}${row}`);
        const address = ws.getCell(`A${row}`);
        address.value = 'Địa chỉ: Khu 23, Xã Thanh Ba, Tỉnh Phú Thọ';
        address.font = tnr(10, false, true);
        address.alignment = { horizontal: 'left', vertical: 'middle' };
        row++;

        ws.getRow(row).height = 6;
        row++;

        merge(
            `A${row}:${LAST}${row}`,
            isExternal ? 'BIÊN BẢN BÀN GIAO MÁY ĐI SỬA NGOÀI' : 'PHIẾU BẢO TRÌ THIẾT BỊ',
            tnr(16, true),
            { horizontal: 'center' }
        );
        ws.getRow(row).height = 28;
        row++;

        merge(`A${row}:${LAST}${row}`, `Ngày lập: ${fmtDateTime(m?.createdAt ?? m?.startDate)}`, tnr(11, false, true), {
            horizontal: 'center',
        });
        row++;

        if (copyLabel) {
            const copyCell = merge(`A${row}:${LAST}${row}`, copyLabel, tnr(11, true), { horizontal: 'center' });
            copyCell.fill = BRAND_FILL;
            for (let c = 1; c <= COLS; c++) ws.getCell(row, c).border = allBorders;
            row++;
        }

        ws.getRow(row).height = 6;
        row++;
        applyOutline(start, row - 1);
    };

    const renderGeneralInfo = () => {
        infoRow('Hình thức:', isExternal ? 'Sửa chữa thuê ngoài / xuất máy ra đơn vị sửa' : 'Sửa chữa nội bộ');
        infoRow('Loại bảo trì:', TYPE_LABEL[m?.type] ?? m?.type ?? '—');
        infoRow('Trạng thái:', STATUS_LABEL[m?.status] ?? m?.status ?? '—');
        infoRow('Cơ sở xuất máy:', m?.plantName || assets[0]?.plant?.name || '—');
        infoRow('Khu vực:', m?.areaAtCreation || assets[0]?.area || '—');

        if (isExternal) {
            infoRow('Đơn vị sửa chữa:', ext?.vendorName || '—', WARNING_FILL);
            infoRow('Ngày bàn giao:', fmtDate(ext?.sentOutAt ?? m?.startDate));
            infoRow('Dự kiến nhận lại:', fmtDate(ext?.expectedReturnAt));
            infoRow('Chi phí dự kiến:', fmtMoney(ext?.estimateCost));
            infoRow('Số hóa đơn / phiếu sửa:', ext?.invoiceNo || '—');
        } else {
            infoRow('Ngày bắt đầu:', fmtDate(m?.startDate));
            infoRow('Ngày hoàn thành:', fmtDate(m?.endDate));
            infoRow('Kỹ thuật viên:', m?.technician || '—');
            infoRow('Chi phí sửa chữa:', fmtMoney(m?.cost));
        }
    };

    const renderMachineTable = () => {
        row++;
        merge(`A${row}:${LAST}${row}`, `DANH SÁCH MÁY BÀN GIAO (${assets.length || 0})`, tnr(12, true), {
            horizontal: 'left',
        });
        row++;

        const headers = ['STT', 'Mã máy', 'Tên máy', 'Serial', 'Hãng / Model', 'Cơ sở / Khu vực', 'Tình trạng / ghi chú'];
        const headerRow = ws.getRow(row);
        headerRow.height = 26;
        headers.forEach((header, index) => {
            const cell = headerRow.getCell(index + 1);
            cell.value = header;
            cell.font = tnr(10, true);
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.fill = HEADER_FILL;
            cell.border = allBorders;
        });
        row++;

        const machineRows = assets.length ? assets : [{}];
        machineRows.forEach((asset: any, index: number) => {
            const values = [
                index + 1,
                asset?.machineCode ?? '—',
                asset?.name ?? '—',
                asset?.serial ?? '—',
                compactText(asset?.brand?.name, asset?.model),
                compactText(asset?.plant?.name, asset?.area),
                m?.description || '—',
            ];
            const current = ws.getRow(row);
            current.height = 34;
            values.forEach((value, col) => {
                const cell = current.getCell(col + 1);
                cell.value = value;
                cell.font = tnr(10);
                cell.border = allBorders;
                cell.alignment = {
                    horizontal: col === 0 ? 'center' : 'left',
                    vertical: 'middle',
                    wrapText: true,
                };
            });
            row++;
        });
    };

    const renderDescription = () => {
        row++;
        infoRow('Nội dung lỗi / yêu cầu sửa:', m?.description || '—');
        if (m?.note) infoRow('Ghi chú nội bộ:', m.note);

        if (!isExternal) return;

        const commitmentStart = row;
        ws.mergeCells(`A${row}:${LAST}${row}`);
        const commitment = ws.getCell(`A${row}`);
        commitment.value =
            'Ghi chú bàn giao: Bên nhận sửa chữa xác nhận đã nhận đúng số lượng, đúng mã máy và tình trạng mô tả trên phiếu. Trong thời gian sửa chữa, bên nhận có trách nhiệm bảo quản máy, thông báo chi phí phát sinh trước khi thực hiện và bàn giao lại đầy đủ khi hoàn tất.';
        commitment.font = tnr(10, false, true);
        commitment.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
        commitment.fill = WARNING_FILL;
        ws.getRow(row).height = 46;
        applyOutline(commitmentStart, row);
        row++;
    };

    const renderCostSection = () => {
        if (!isExternal) return;

        row++;
        merge(`A${row}:${LAST}${row}`, 'THÔNG TIN CHI PHÍ SỬA NGOÀI', tnr(12, true), { horizontal: 'left' });
        row++;

        const headers = ['STT', 'Hạng mục', '', '', 'Số tiền (đ)', 'Ghi chú', ''];
        const headerRow = ws.getRow(row);
        headers.forEach((header, index) => {
            const cell = headerRow.getCell(index + 1);
            cell.value = header;
            cell.font = tnr(10, true);
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.fill = HEADER_FILL;
            cell.border = allBorders;
        });
        ws.mergeCells(`B${row}:D${row}`);
        ws.mergeCells(`F${row}:G${row}`);
        row++;

        const costItems: any[] = Array.isArray(ext?.costItems) ? ext.costItems : [];
        const fallbackAmount = Number(ext?.actualCost ?? 0) || Number(ext?.estimateCost ?? 0) || 0;
        const rows = costItems.length
            ? costItems
            : [{ name: 'Chi phí sửa chữa dự kiến', amount: fallbackAmount, note: '' }];
        let total = 0;

        rows.forEach((item: any, index: number) => {
            const amount = Number(item?.amount ?? 0);
            total += amount;
            const current = row;
            ws.getCell(`A${row}`).value = index + 1;
            ws.mergeCells(`B${row}:D${row}`);
            ws.getCell(`B${row}`).value = item?.name || '—';
            ws.getCell(`E${row}`).value = amount;
            ws.getCell(`E${row}`).numFmt = '#,##0';
            ws.mergeCells(`F${row}:G${row}`);
            ws.getCell(`F${row}`).value = item?.note || '';

            for (let c = 1; c <= COLS; c++) {
                const cell = ws.getCell(row, c);
                cell.font = tnr(10);
                cell.border = allBorders;
                cell.alignment = {
                    horizontal: c === 1 ? 'center' : c === 5 ? 'right' : 'left',
                    vertical: 'middle',
                    wrapText: true,
                };
            }
            ws.getRow(current).height = 24;
            row++;
        });

        ws.mergeCells(`A${row}:D${row}`);
        ws.getCell(`A${row}`).value = 'TỔNG CHI PHÍ';
        ws.getCell(`A${row}`).font = tnr(11, true);
        ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getCell(`E${row}`).value = total;
        ws.getCell(`E${row}`).numFmt = '#,##0';
        ws.getCell(`E${row}`).font = tnr(11, true);
        ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
        ws.mergeCells(`F${row}:G${row}`);
        ws.getCell(`F${row}`).value = `Duyệt: ${APPROVAL_LABEL[m?.approvalStatus] ?? '—'}`;
        ws.getCell(`F${row}`).font = tnr(10, true);
        ws.getCell(`F${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
        applyOutline(row, row);
        row++;
    };

    const renderSignatures = () => {
        row += 2;
        const labelRow = row;
        ws.mergeCells(`A${row}:B${row}`);
        ws.mergeCells(`C${row}:D${row}`);
        ws.mergeCells(`E${row}:${LAST}${row}`);

        ws.getCell(`A${row}`).value = 'Người giao máy';
        ws.getCell(`C${row}`).value = isExternal ? 'Bên nhận sửa chữa' : 'Người thực hiện';
        ws.getCell(`E${row}`).value = isExternal ? 'Quản lý / Người duyệt' : 'Quản lý xác nhận';
        [`A${row}`, `C${row}`, `E${row}`].forEach((addr) => {
            const cell = ws.getCell(addr);
            cell.font = tnr(11, true);
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
        row++;

        ws.getRow(row).height = 54;
        row++;

        ws.mergeCells(`A${row}:B${row}`);
        ws.mergeCells(`C${row}:D${row}`);
        ws.mergeCells(`E${row}:${LAST}${row}`);
        ws.getCell(`A${row}`).value = '(Ký, họ tên)';
        ws.getCell(`C${row}`).value = '(Ký, họ tên, đóng dấu nếu có)';
        ws.getCell(`E${row}`).value = '(Ký, họ tên)';
        [`A${row}`, `C${row}`, `E${row}`].forEach((addr) => {
            const cell = ws.getCell(addr);
            cell.font = tnr(10, false, true);
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
        applyOutline(labelRow, row);
        for (let c = 1; c <= COLS; c++) {
            ws.getCell(labelRow, c).border = { top: medium, left: thin, bottom: thin, right: thin };
        }
        row++;
    };

    const renderVoucherCopy = (copyLabel?: string) => {
        renderHeader(copyLabel);
        renderGeneralInfo();
        renderMachineTable();
        renderDescription();
        renderCostSection();
        renderSignatures();
    };

    if (isExternal) {
        renderVoucherCopy('LIÊN 1: HẢI ĐĂNG LƯU');
        ws.getRow(row).addPageBreak();
        row += 2;
        renderVoucherCopy('LIÊN 2: ĐƠN VỊ SỬA CHỮA GIỮ');
    } else {
        renderVoucherCopy();
    }

    ws.eachRow((sheetRow) => {
        sheetRow.eachCell((cell) => {
            cell.alignment = { vertical: 'middle', wrapText: true, ...(cell.alignment ?? {}) };
        });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
