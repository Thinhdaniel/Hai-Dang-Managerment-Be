import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionOpeningBalanceBatch from '@/models/ProductionOpeningBalanceBatch';
import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { StatusCodes } from 'http-status-codes';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
    buildProductionOpeningBalanceEntryKey,
    previewProductionOpeningBalanceWorkbook,
    summarizeOpeningBalanceEntries,
    type ProductionOpeningBalanceResolvedEntry,
} from './production-opening-balance.helpers';
import { sendSuccess } from './service.helpers';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR_SELECT = 'fullname username email';
const BATCH_ACTOR_PATHS = [
    { path: 'confirmedBy', select: ACTOR_SELECT },
    { path: 'voidedBy', select: ACTOR_SELECT },
    { path: 'history.actor', select: ACTOR_SELECT },
];

const toId = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const toIso = (value: any): string | undefined => (value ? new Date(value).toISOString() : undefined);

const actorName = (value: any): string | undefined => {
    if (!value || typeof value === 'string') return undefined;
    return value.fullname || value.username || value.email || undefined;
};

const serializeActor = (value: any) => {
    const id = toId(value);
    return id ? { id, name: actorName(value) } : undefined;
};

const userPlantId = (req: Request): string => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền quản lý sản lượng đầu kỳ của cơ sở này');
    }
};

const resolvePlant = async (req: Request, input?: unknown) => {
    const plantId = String(input || userPlantId(req) || '');
    if (!plantId) throw new BadRequestError('Cần chọn cơ sở');
    assertPlantAccess(req, plantId);
    const plant: any = await Plant.findById(plantId).select('name code').lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: plantId, name: String(plant.name || ''), code: String(plant.code || '') };
};

const assertDate = (input: unknown) => {
    const value = String(input || '');
    if (!DATE_PATTERN.test(value)) throw new BadRequestError('Ngày chốt đầu kỳ không hợp lệ');
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new BadRequestError('Ngày chốt đầu kỳ không hợp lệ');
    }
    return value;
};

const normalizeOrderCode = (value: unknown) =>
    String(value || '')
        .trim()
        .toUpperCase();

const canonicalEntries = (entries: ProductionOpeningBalanceResolvedEntry[]) =>
    [...entries]
        .map((entry) => ({
            lineId: entry.lineId,
            itemId: entry.itemId || '',
            orderCode: normalizeOrderCode(entry.orderCode),
            quantity: Number(entry.quantity),
            unitPriceSnapshot:
                entry.unitPriceSnapshot === undefined ? null : Number(entry.unitPriceSnapshot),
        }))
        .sort((left, right) =>
            `${left.lineId}|${left.itemId}|${left.orderCode}`.localeCompare(
                `${right.lineId}|${right.itemId}|${right.orderCode}`
            )
        );

const fingerprint = (
    plantId: string,
    cutoffDate: string,
    entries: ProductionOpeningBalanceResolvedEntry[]
) => {
    const hash = createHash('sha256');
    hash.update(`${plantId}|${cutoffDate}|`);
    hash.update(JSON.stringify(canonicalEntries(entries)));
    return hash.digest('hex');
};

const batchCode = (cutoffDate: string) =>
    `OB-${cutoffDate.replace(/-/g, '')}-${nanoid(6).toUpperCase().replace(/[-_]/g, 'X')}`;

const serializeEntry = (entry: any) => ({
    id: toId(entry),
    lineId: toId(entry.lineId),
    lineCode: entry.lineCode,
    lineName: entry.lineName,
    itemId: toId(entry.itemId),
    itemCode: entry.itemCode,
    itemName: entry.itemName,
    orderCode: entry.orderCode,
    unit: entry.unit || 'SP',
    quantity: Number(entry.quantity || 0),
    unitPriceSnapshot:
        entry.unitPriceSnapshot === undefined || entry.unitPriceSnapshot === null
            ? undefined
            : Number(entry.unitPriceSnapshot),
    amountSnapshot:
        entry.amountSnapshot === undefined || entry.amountSnapshot === null
            ? undefined
            : Number(entry.amountSnapshot),
    allocationState: entry.allocationState || 'exact',
    sourceRow: entry.sourceRow ? Number(entry.sourceRow) : undefined,
});

export const serializeProductionOpeningBalanceBatch = (input: any, includeEntries = true) => {
    const batch = typeof input?.toObject === 'function' ? input.toObject() : input;
    return {
        id: toId(batch),
        code: batch.code,
        plantId: toId(batch.plantId),
        plantName: batch.plantName,
        plantCode: batch.plantCode,
        cutoffDate: batch.cutoffDate,
        sourceType: batch.sourceType,
        sourceFileName: batch.sourceFileName,
        sourceFileSize: Number(batch.sourceFileSize || 0),
        sourceSheet: batch.sourceSheet,
        note: batch.note,
        status: batch.status,
        summary: {
            entryCount: Number(batch.summary?.entryCount || 0),
            totalQuantity: Number(batch.summary?.totalQuantity || 0),
            exactQuantity: Number(batch.summary?.exactQuantity || 0),
            unallocatedQuantity: Number(batch.summary?.unallocatedQuantity || 0),
            valuedQuantity: Number(batch.summary?.valuedQuantity || 0),
            totalAmount: Number(batch.summary?.totalAmount || 0),
        },
        ...(includeEntries ? { entries: (batch.entries || []).map(serializeEntry) } : {}),
        confirmedBy: serializeActor(batch.confirmedBy),
        confirmedAt: toIso(batch.confirmedAt),
        voidedBy: serializeActor(batch.voidedBy),
        voidedAt: toIso(batch.voidedAt),
        voidReason: batch.voidReason,
        history: (batch.history || []).map((event: any) => ({
            id: toId(event),
            type: event.type,
            reason: event.reason,
            actor: serializeActor(event.actor),
            at: toIso(event.at),
        })),
        createdAt: toIso(batch.createdAt),
        updatedAt: toIso(batch.updatedAt),
    };
};

const activeCoverage = (batches: any[]) => {
    const active = batches.filter((batch) => batch.status === 'confirmed');
    const summary = active.reduce(
        (result, batch) => ({
            entryCount: result.entryCount + Number(batch.summary?.entryCount || 0),
            totalQuantity: result.totalQuantity + Number(batch.summary?.totalQuantity || 0),
            exactQuantity: result.exactQuantity + Number(batch.summary?.exactQuantity || 0),
            unallocatedQuantity:
                result.unallocatedQuantity + Number(batch.summary?.unallocatedQuantity || 0),
            valuedQuantity: result.valuedQuantity + Number(batch.summary?.valuedQuantity || 0),
            totalAmount: result.totalAmount + Number(batch.summary?.totalAmount || 0),
        }),
        {
            entryCount: 0,
            totalQuantity: 0,
            exactQuantity: 0,
            unallocatedQuantity: 0,
            valuedQuantity: 0,
            totalAmount: 0,
        }
    );
    return {
        available: active.length > 0,
        cutoffDate: active[0]?.cutoffDate,
        batchCount: active.length,
        ...summary,
        amountCoveragePercent:
            summary.totalQuantity > 0
                ? Number(((summary.valuedQuantity / summary.totalQuantity) * 100).toFixed(1))
                : 100,
        lastConfirmedAt: active
            .map((batch) => batch.confirmedAt)
            .filter(Boolean)
            .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0],
    };
};

const assertCutoffCompatible = async (plantId: string, cutoffDate: string) => {
    const existing: any = await ProductionOpeningBalanceBatch.findOne({
        plantId,
        status: 'confirmed',
    })
        .select('cutoffDate')
        .lean();
    if (existing && existing.cutoffDate !== cutoffDate) {
        throw new BadRequestError(
            `Cơ sở đã chốt đầu kỳ đến ${existing.cutoffDate}. Hãy dùng cùng ngày hoặc hủy các batch cũ trước`
        );
    }

    const earliestDay: any = await ProductionDay.findOne({ plantId })
        .sort({ productionDate: 1 })
        .select('productionDate')
        .lean();
    if (earliestDay && cutoffDate >= earliestDay.productionDate) {
        throw new BadRequestError(
            `Ngày chốt đầu kỳ phải trước ngày bắt đầu nhập hệ thống ${earliestDay.productionDate}`
        );
    }
};

const createConfirmedBatch = async ({
    req,
    plant,
    cutoffDate,
    note,
    entries,
    sourceType,
    file,
    sourceSheet,
}: {
    req: Request;
    plant: { id: string; name: string; code: string };
    cutoffDate: string;
    note: string;
    entries: ProductionOpeningBalanceResolvedEntry[];
    sourceType: 'manual' | 'excel';
    file?: Express.Multer.File;
    sourceSheet?: string;
}) => {
    if (!req.userId) throw new UnAuthorizedError('Phiên đăng nhập không hợp lệ');
    if (!entries.length) throw new BadRequestError('Không có dòng sản lượng đầu kỳ hợp lệ');
    await assertCutoffCompatible(plant.id, cutoffDate);
    const summary = summarizeOpeningBalanceEntries(entries);
    const sourceFingerprint = fingerprint(plant.id, cutoffDate, entries);
    const duplicated = await ProductionOpeningBalanceBatch.exists({
        plantId: plant.id,
        fingerprint: sourceFingerprint,
        status: 'confirmed',
    });
    if (duplicated) throw new DuplicateError('Dữ liệu đầu kỳ này đã được xác nhận trước đó');

    try {
        const batch: any = await ProductionOpeningBalanceBatch.create({
            code: batchCode(cutoffDate),
            plantId: plant.id,
            plantName: plant.name,
            plantCode: plant.code,
            cutoffDate,
            sourceType,
            sourceFileName: file?.originalname,
            sourceFileSize: file?.size,
            sourceSheet,
            fingerprint: sourceFingerprint,
            note,
            status: 'confirmed',
            entries,
            summary,
            confirmedBy: req.userId,
            confirmedAt: new Date(),
            history: [{ type: 'confirmed', reason: note, actor: req.userId, at: new Date() }],
        });
        await batch.populate(BATCH_ACTOR_PATHS);
        emitToPlant(plant.id, 'production:updated', {
            plantId: plant.id,
            changeType: 'opening-balance-confirmed',
            batchId: String(batch._id),
            actorId: req.userId,
        });
        return batch;
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Dữ liệu đầu kỳ này đã được xác nhận trước đó');
        throw error;
    }
};

const resolveManualEntries = async (
    plantId: string,
    inputs: Array<{
        lineId: string;
        itemId?: string | null;
        orderCode?: string;
        quantity: number;
        unitPrice?: number | null;
    }>
) => {
    const lineIds = [...new Set(inputs.map((entry) => String(entry.lineId)))];
    const itemIds = [
        ...new Set(inputs.map((entry) => String(entry.itemId || '')).filter(Boolean)),
    ];
    const [lines, items] = await Promise.all([
        ProductionLine.find({ _id: { $in: lineIds }, plantId }).lean(),
        itemIds.length ? ProductionItem.find({ _id: { $in: itemIds }, plantId }).lean() : [],
    ]);
    const lineById = new Map(lines.map((line: any) => [String(line._id), line]));
    const itemById = new Map(items.map((item: any) => [String(item._id), item]));
    const seen = new Set<string>();

    return inputs.map((input) => {
        const line: any = lineById.get(String(input.lineId));
        if (!line) throw new BadRequestError('Có chuyền không thuộc cơ sở đã chọn');
        const item: any = input.itemId ? itemById.get(String(input.itemId)) : undefined;
        if (input.itemId && !item) throw new BadRequestError('Có mã hàng không thuộc cơ sở đã chọn');
        const orderCode = String(input.orderCode || '').trim();
        if (orderCode && !item) throw new BadRequestError('Không thể gán đơn hàng cho dòng chưa phân bổ mã hàng');
        const key = `${line._id}|${item?._id || ''}|${normalizeOrderCode(orderCode)}`;
        if (seen.has(key)) throw new BadRequestError('Dòng đầu kỳ bị trùng chuyền, mã hàng và đơn hàng');
        seen.add(key);
        const unitPrice =
            input.unitPrice === null || input.unitPrice === undefined ? undefined : Number(input.unitPrice);
        const quantity = Number(input.quantity);
        return {
            entryKey: buildProductionOpeningBalanceEntryKey(line._id, item?._id, orderCode),
            lineId: String(line._id),
            lineCode: line.code,
            lineName: line.name,
            itemId: item ? String(item._id) : undefined,
            itemCode: item?.code,
            itemName: item?.name,
            orderCode: orderCode || undefined,
            unit: item?.unit || 'SP',
            quantity,
            unitPriceSnapshot: unitPrice,
            amountSnapshot: unitPrice !== undefined ? quantity * unitPrice : undefined,
            allocationState: item ? ('exact' as const) : ('unallocated' as const),
        };
    });
};

const loadWorkbookPreview = async (req: Request, plantId: string) => {
    if (!req.file) throw new BadRequestError('Vui lòng chọn file Excel');
    if (!/\.xlsx$/i.test(req.file.originalname)) {
        throw new BadRequestError('Sản lượng đầu kỳ chỉ hỗ trợ file XLSX');
    }
    const [lines, items] = await Promise.all([
        ProductionLine.find({ plantId }).select('code name').lean(),
        ProductionItem.find({ plantId }).select('code name unit').lean(),
    ]);
    try {
        return await previewProductionOpeningBalanceWorkbook(req.file.buffer, lines, items);
    } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : 'Không đọc được file Excel');
    }
};

export const loadConfirmedProductionOpeningBalances = async (plantId: string) => {
    const batches: any[] = await ProductionOpeningBalanceBatch.find({
        plantId,
        status: 'confirmed',
    })
        .sort({ confirmedAt: 1 })
        .lean();
    return {
        coverage: activeCoverage(batches),
        batches,
        entries: batches.flatMap((batch) => (batch.entries || []).map(serializeEntry)),
    };
};

export const listProductionOpeningBalances = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const batches: any[] = await ProductionOpeningBalanceBatch.find({ plantId: plant.id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate(BATCH_ACTOR_PATHS);
    return sendSuccess(
        res,
        {
            plant,
            coverage: activeCoverage(batches),
            batches: batches.map((batch) => serializeProductionOpeningBalanceBatch(batch)),
        },
        'Đã tải sản lượng đầu kỳ'
    );
};

export const createManualProductionOpeningBalance = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const cutoffDate = assertDate(req.body.cutoffDate);
    const entries = await resolveManualEntries(plant.id, req.body.entries || []);
    const batch = await createConfirmedBatch({
        req,
        plant,
        cutoffDate,
        note: String(req.body.note || '').trim(),
        entries,
        sourceType: 'manual',
    });
    return sendSuccess(
        res,
        serializeProductionOpeningBalanceBatch(batch),
        'Đã xác nhận sản lượng đầu kỳ',
        StatusCodes.CREATED
    );
};

export const previewProductionOpeningBalanceImport = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const cutoffDate = assertDate(req.body.cutoffDate);
    await assertCutoffCompatible(plant.id, cutoffDate);
    const preview = await loadWorkbookPreview(req, plant.id);
    return sendSuccess(
        res,
        {
            plant,
            cutoffDate,
            fileName: req.file?.originalname,
            sheetName: preview.sheetName,
            headerRow: preview.headerRow,
            summary: preview.summary,
            rows: preview.rows,
        },
        preview.summary.invalidRows
            ? `Có ${preview.summary.invalidRows} dòng cần sửa`
            : 'File đầu kỳ hợp lệ và sẵn sàng xác nhận'
    );
};

export const confirmProductionOpeningBalanceImport = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const cutoffDate = assertDate(req.body.cutoffDate);
    const preview = await loadWorkbookPreview(req, plant.id);
    if (preview.summary.invalidRows > 0) {
        throw new BadRequestError(`Còn ${preview.summary.invalidRows} dòng lỗi, không thể xác nhận một phần`);
    }
    const batch = await createConfirmedBatch({
        req,
        plant,
        cutoffDate,
        note: String(req.body.note || '').trim(),
        entries: preview.entries,
        sourceType: 'excel',
        file: req.file,
        sourceSheet: preview.sheetName,
    });
    return sendSuccess(
        res,
        serializeProductionOpeningBalanceBatch(batch),
        'Đã nhập và xác nhận sản lượng đầu kỳ',
        StatusCodes.CREATED
    );
};

export const voidProductionOpeningBalance = async (req: Request, res: Response) => {
    const batch: any = await ProductionOpeningBalanceBatch.findById(req.params.id);
    if (!batch) throw new NotFoundError('Không tìm thấy batch sản lượng đầu kỳ');
    assertPlantAccess(req, String(batch.plantId));
    if (batch.status === 'voided') throw new BadRequestError('Batch này đã được hủy trước đó');
    if (!req.userId) throw new UnAuthorizedError('Phiên đăng nhập không hợp lệ');
    batch.status = 'voided';
    batch.voidedBy = req.userId;
    batch.voidedAt = new Date();
    batch.voidReason = String(req.body.reason || '').trim();
    batch.history.push({
        type: 'voided',
        reason: batch.voidReason,
        actor: req.userId,
        at: batch.voidedAt,
    });
    await batch.save();
    await batch.populate(BATCH_ACTOR_PATHS);
    emitToPlant(String(batch.plantId), 'production:updated', {
        plantId: String(batch.plantId),
        changeType: 'opening-balance-voided',
        batchId: String(batch._id),
        actorId: req.userId,
    });
    return sendSuccess(res, serializeProductionOpeningBalanceBatch(batch), 'Đã hủy batch sản lượng đầu kỳ');
};

export const downloadProductionOpeningBalanceTemplate = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    workbook.company = 'Công ty TNHH May Xuất Khẩu Hải Đăng';
    const sheet = workbook.addWorksheet('Sản lượng đầu kỳ');
    sheet.columns = [
        { header: 'Mã chuyền (*)', key: 'lineCode', width: 18 },
        { header: 'Mã hàng', key: 'itemCode', width: 20 },
        { header: 'Mã đơn hàng', key: 'orderCode', width: 22 },
        { header: 'Sản lượng đầu kỳ (*)', key: 'quantity', width: 24 },
        { header: 'ĐVT', key: 'unit', width: 12 },
        { header: 'Đơn giá lịch sử', key: 'unitPrice', width: 20 },
    ];
    const header = sheet.getRow(1);
    header.height = 28;
    header.eachCell((cell) => {
        cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF147A4B' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    sheet.addRow(['CM1', 'MH-001', 'DH-2026-001', 12500, 'SP', 850]);
    sheet.addRow(['CM2', '', '', 3200, 'SP', '']);
    sheet.autoFilter = 'A1:F3';
    sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];

    const guide = workbook.addWorksheet('Hướng dẫn');
    guide.getColumn(1).width = 105;
    [
        `MẪU SẢN LƯỢNG ĐẦU KỲ - ${plant.name}`,
        '',
        'Mỗi dòng phải có mã chuyền và sản lượng lớn hơn 0.',
        'Có mã hàng: số liệu được phân bổ chính xác theo mã hàng và đơn hàng.',
        'Bỏ trống mã hàng: số liệu vẫn cộng vào chuyền nhưng được đánh dấu "Chưa phân bổ".',
        'Đơn giá lịch sử là tùy chọn. Bỏ trống thì giá trị lũy kế sẽ được ghi nhận là chưa đủ dữ liệu.',
        'Không lặp lại cùng tổ hợp Mã chuyền + Mã hàng + Mã đơn hàng.',
        'Hệ thống chỉ xác nhận khi toàn bộ dòng trong file đều hợp lệ.',
    ].forEach((text, index) => {
        const row = guide.addRow([text]);
        row.getCell(1).alignment = { vertical: 'top', wrapText: true };
        if (index === 0) row.getCell(1).font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF147A4B' } };
    });
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="production-opening-balance-${plant.code || plant.id}.xlsx"`
    );
    return res.send(Buffer.from(buffer));
};
