import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToPlant } from '@/lib/socket';
import Plant from '@/models/Plant';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionQcOpeningBalanceBatch from '@/models/ProductionQcOpeningBalanceBatch';
import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { StatusCodes } from 'http-status-codes';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { loadConfirmedProductionOpeningBalances } from './production-opening-balance.service';
import {
    buildProductionQcOpeningEntryKey,
    previewProductionQcOpeningWorkbook,
    summarizeQcOpeningEntries,
    type ProductionQcOpeningResolvedEntry,
} from './production-qc-opening-balance.helpers';
import { sendSuccess } from './service.helpers';

const ACTOR_SELECT = 'fullname username email';
const BATCH_ACTOR_PATHS = [
    { path: 'confirmedBy', select: ACTOR_SELECT },
    { path: 'voidedBy', select: ACTOR_SELECT },
    { path: 'history.actor', select: ACTOR_SELECT },
];

const toId = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    return String(value._id ?? value);
};
const toIso = (value: any): string | undefined => (value ? new Date(value).toISOString() : undefined);
const actorName = (value: any): string | undefined =>
    value && typeof value !== 'string' ? value.fullname || value.username || value.email || undefined : undefined;
const serializeActor = (value: any) => {
    const id = toId(value);
    return id ? { id, name: actorName(value) } : undefined;
};
const normalizeOrderCode = (value: unknown) =>
    String(value || '')
        .trim()
        .toUpperCase();
const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền quản lý số đầu kỳ QC của cơ sở này');
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
    mode: entry.mode || 'full',
    passedQuantity: Number(entry.passedQuantity || 0),
    defectQuantity: Number(entry.defectQuantity || 0),
    inspectedQuantity: Number(entry.passedQuantity || 0) + Number(entry.defectQuantity || 0),
    pendingQuantity: Number(entry.pendingQuantity || 0),
    allocationState: entry.allocationState || 'exact',
    sourceRow: entry.sourceRow ? Number(entry.sourceRow) : undefined,
});

export const serializeProductionQcOpeningBatch = (input: any, includeEntries = true) => {
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
            passedQuantity: Number(batch.summary?.passedQuantity || 0),
            defectQuantity: Number(batch.summary?.defectQuantity || 0),
            inspectedQuantity: Number(batch.summary?.inspectedQuantity || 0),
            pendingQuantity: Number(batch.summary?.pendingQuantity || 0),
            exactPendingQuantity: Number(batch.summary?.exactPendingQuantity || 0),
            unallocatedPendingQuantity: Number(batch.summary?.unallocatedPendingQuantity || 0),
            fullEntryCount: Number(batch.summary?.fullEntryCount || 0),
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
        (result, batch) => {
            Object.keys(result).forEach((key) => {
                result[key] += Number(batch.summary?.[key] || 0);
            });
            return result;
        },
        {
            entryCount: 0,
            passedQuantity: 0,
            defectQuantity: 0,
            inspectedQuantity: 0,
            pendingQuantity: 0,
            exactPendingQuantity: 0,
            unallocatedPendingQuantity: 0,
            fullEntryCount: 0,
        } as Record<string, number>
    );
    return {
        available: active.length > 0,
        cutoffDate: active[0]?.cutoffDate,
        batchCount: active.length,
        ...summary,
        exactCoveragePercent:
            summary.pendingQuantity > 0
                ? Number(((summary.exactPendingQuantity / summary.pendingQuantity) * 100).toFixed(1))
                : 100,
        historicalQualityComplete: summary.entryCount === summary.fullEntryCount,
        lastConfirmedAt: active
            .map((batch) => batch.confirmedAt)
            .filter(Boolean)
            .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0],
    };
};

const assertCutoffCompatible = async (plantId: string, cutoffDate: string) => {
    const productionOpening = await loadConfirmedProductionOpeningBalances(plantId);
    if (!productionOpening.coverage.available) {
        throw new BadRequestError('Cần khai báo sản lượng đầu kỳ trước khi khai báo QC đầu kỳ');
    }
    if (String(productionOpening.coverage.cutoffDate) !== cutoffDate) {
        throw new BadRequestError(
            `QC đầu kỳ phải dùng cùng ngày chốt sản lượng ${productionOpening.coverage.cutoffDate}`
        );
    }
    const existing: any = await ProductionQcOpeningBalanceBatch.findOne({ plantId, status: 'confirmed' })
        .select('cutoffDate')
        .lean();
    if (existing && existing.cutoffDate !== cutoffDate) {
        throw new BadRequestError(`Cơ sở đã có QC đầu kỳ chốt đến ${existing.cutoffDate}`);
    }
    return productionOpening;
};

const productionKey = (lineId: unknown, itemId?: unknown, orderCode?: unknown) =>
    `${String(lineId || '')}|${String(itemId || '')}|${normalizeOrderCode(orderCode)}`;

const reconcileEntries = (entries: ProductionQcOpeningResolvedEntry[], productionEntries: any[]) => {
    const productionByKey = new Map<string, number>();
    const productionByLine = new Map<string, number>();
    productionEntries.forEach((entry) => {
        const key = productionKey(entry.lineId, entry.itemId, entry.orderCode);
        productionByKey.set(key, Number(productionByKey.get(key) || 0) + Number(entry.quantity || 0));
        const lineId = String(entry.lineId || '');
        productionByLine.set(lineId, Number(productionByLine.get(lineId) || 0) + Number(entry.quantity || 0));
    });
    const fullCoveredByLine = new Map<string, number>();
    const backlogPendingByLine = new Map<string, number>();
    entries.forEach((entry) => {
        const lineId = String(entry.lineId || '');
        if (entry.mode === 'full') {
            const productionQuantity = productionByKey.get(productionKey(entry.lineId, entry.itemId, entry.orderCode));
            if (productionQuantity !== undefined) {
                fullCoveredByLine.set(lineId, Number(fullCoveredByLine.get(lineId) || 0) + productionQuantity);
            }
            return;
        }
        backlogPendingByLine.set(
            lineId,
            Number(backlogPendingByLine.get(lineId) || 0) + Number(entry.pendingQuantity || 0)
        );
    });
    const rows = entries.map((entry) => {
        const lineId = String(entry.lineId || '');
        const declaredQuantity =
            Number(entry.passedQuantity || 0) + Number(entry.defectQuantity || 0) + Number(entry.pendingQuantity || 0);
        const productionQuantity = productionByKey.get(productionKey(entry.lineId, entry.itemId, entry.orderCode));
        const variance = productionQuantity === undefined ? undefined : declaredQuantity - productionQuantity;
        const lineProductionQuantity = productionByLine.get(lineId);
        const backlogCapacity = Math.max(
            0,
            Number(lineProductionQuantity || 0) - Number(fullCoveredByLine.get(lineId) || 0)
        );
        const backlogPending = Number(backlogPendingByLine.get(lineId) || 0);
        const backlogHasSource = entry.itemId ? productionQuantity !== undefined : lineProductionQuantity !== undefined;
        const backlogFitsExactSource =
            !entry.itemId || Number(entry.pendingQuantity || 0) <= Number(productionQuantity || 0);
        const backlogFitsLine = backlogPending <= backlogCapacity;
        const reconciled =
            entry.mode === 'backlog_only'
                ? backlogHasSource && backlogFitsExactSource && backlogFitsLine
                : productionQuantity !== undefined && Math.abs(Number(variance || 0)) < 0.001;
        let message: string;
        if (entry.mode === 'backlog_only') {
            if (!backlogHasSource) {
                message = 'Không tìm thấy nguồn sản lượng đầu kỳ tương ứng';
            } else if (!backlogFitsExactSource) {
                message = `Tồn chờ vượt nguồn mã hàng ${Number(productionQuantity || 0).toLocaleString('vi-VN')} sản phẩm`;
            } else if (!backlogFitsLine) {
                message = `Tổng tồn chờ của chuyền vượt nguồn còn lại ${backlogCapacity.toLocaleString('vi-VN')} sản phẩm`;
            } else {
                message = 'Đã kiểm tra tồn chờ với nguồn sản lượng; không có tỷ lệ chất lượng lịch sử';
            }
        } else if (productionQuantity === undefined) {
            message = 'Không tìm thấy dòng sản lượng đầu kỳ tương ứng';
        } else if (reconciled) {
            message = 'Khớp sản lượng đầu kỳ';
        } else {
            message = `Lệch ${Math.abs(Number(variance || 0)).toLocaleString('vi-VN')} sản phẩm`;
        }
        return {
            entryKey: entry.entryKey,
            lineCode: entry.lineCode,
            itemCode: entry.itemCode,
            orderCode: entry.orderCode,
            mode: entry.mode,
            productionQuantity,
            declaredQuantity,
            variance,
            reconciled,
            message,
        };
    });
    return {
        rows,
        invalidCount: rows.filter((row) => !row.reconciled).length,
        backlogOnlyCount: rows.filter((row) => row.mode === 'backlog_only').length,
    };
};

const canonicalEntries = (entries: ProductionQcOpeningResolvedEntry[]) =>
    [...entries]
        .map((entry) => ({
            lineId: entry.lineId,
            itemId: entry.itemId || '',
            orderCode: normalizeOrderCode(entry.orderCode),
            mode: entry.mode,
            passedQuantity: entry.passedQuantity,
            defectQuantity: entry.defectQuantity,
            pendingQuantity: entry.pendingQuantity,
        }))
        .sort((left, right) =>
            `${left.lineId}|${left.itemId}|${left.orderCode}`.localeCompare(
                `${right.lineId}|${right.itemId}|${right.orderCode}`
            )
        );

const fingerprint = (plantId: string, cutoffDate: string, entries: ProductionQcOpeningResolvedEntry[]) =>
    createHash('sha256')
        .update(`${plantId}|${cutoffDate}|${JSON.stringify(canonicalEntries(entries))}`)
        .digest('hex');
const batchCode = (cutoffDate: string) =>
    `QCOB-${cutoffDate.replace(/-/g, '')}-${nanoid(6).toUpperCase().replace(/[-_]/g, 'X')}`;

const resolveManualEntries = async (plantId: string, inputs: any[]) => {
    const lineIds = [...new Set(inputs.map((entry) => String(entry.lineId)))];
    const itemIds = [...new Set(inputs.map((entry) => String(entry.itemId || '')).filter(Boolean))];
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
        const orderCode = normalizeOrderCode(input.orderCode);
        const key = buildProductionQcOpeningEntryKey(line._id, item?._id, orderCode);
        if (seen.has(key)) throw new BadRequestError('Dòng QC đầu kỳ bị trùng chuyền, mã hàng và đơn hàng');
        seen.add(key);
        return {
            entryKey: key,
            lineId: String(line._id),
            lineCode: line.code,
            lineName: line.name,
            itemId: item ? String(item._id) : undefined,
            itemCode: item?.code,
            itemName: item?.name,
            orderCode: orderCode || undefined,
            unit: item?.unit || 'SP',
            mode: input.mode || 'full',
            passedQuantity: Number(input.passedQuantity || 0),
            defectQuantity: Number(input.defectQuantity || 0),
            pendingQuantity: Number(input.pendingQuantity || 0),
            allocationState: item ? ('exact' as const) : ('unallocated' as const),
        };
    });
};

const loadWorkbookPreview = async (req: Request, plantId: string) => {
    if (!req.file) throw new BadRequestError('Vui lòng chọn file Excel');
    if (!/\.xlsx$/i.test(req.file.originalname)) throw new BadRequestError('QC đầu kỳ chỉ hỗ trợ file XLSX');
    const [lines, items] = await Promise.all([
        ProductionLine.find({ plantId }).select('code name').lean(),
        ProductionItem.find({ plantId }).select('code name unit').lean(),
    ]);
    try {
        return await previewProductionQcOpeningWorkbook(req.file.buffer, lines, items);
    } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : 'Không đọc được file Excel');
    }
};

const createConfirmedBatch = async (args: {
    req: Request;
    plant: { id: string; name: string; code: string };
    cutoffDate: string;
    note: string;
    entries: ProductionQcOpeningResolvedEntry[];
    sourceType: 'manual' | 'excel';
    file?: Express.Multer.File;
    sourceSheet?: string;
}) => {
    const { req, plant, cutoffDate, note, entries, sourceType, file, sourceSheet } = args;
    if (!req.userId) throw new UnAuthorizedError('Phiên đăng nhập không hợp lệ');
    const productionOpening = await assertCutoffCompatible(plant.id, cutoffDate);
    const reconciliation = reconcileEntries(entries, productionOpening.entries);
    if (reconciliation.invalidCount) {
        throw new BadRequestError(
            `Còn ${reconciliation.invalidCount} dòng QC đầu kỳ chưa khớp sản lượng. Hãy sửa hoặc dùng chế độ chỉ biết tồn`
        );
    }
    const sourceFingerprint = fingerprint(plant.id, cutoffDate, entries);
    try {
        const batch: any = await ProductionQcOpeningBalanceBatch.create({
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
            summary: summarizeQcOpeningEntries(entries),
            confirmedBy: req.userId,
            confirmedAt: new Date(),
            history: [{ type: 'confirmed', reason: note, actor: req.userId, at: new Date() }],
        });
        await batch.populate(BATCH_ACTOR_PATHS);
        emitToPlant(plant.id, 'production:updated', {
            plantId: plant.id,
            changeType: 'qc-opening-balance-confirmed',
            batchId: String(batch._id),
            actorId: req.userId,
        });
        return batch;
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Dữ liệu QC đầu kỳ này đã được xác nhận trước đó');
        throw error;
    }
};

export const loadConfirmedProductionQcOpeningBalances = async (plantId: string) => {
    const batches: any[] = await ProductionQcOpeningBalanceBatch.find({ plantId, status: 'confirmed' })
        .sort({ confirmedAt: 1 })
        .lean();
    return {
        coverage: activeCoverage(batches),
        batches,
        entries: batches.flatMap((batch) => (batch.entries || []).map(serializeEntry)),
    };
};

export const listProductionQcOpeningBalances = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const batches: any[] = await ProductionQcOpeningBalanceBatch.find({ plantId: plant.id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate(BATCH_ACTOR_PATHS);
    return sendSuccess(
        res,
        {
            plant,
            coverage: activeCoverage(batches),
            batches: batches.map((batch) => serializeProductionQcOpeningBatch(batch)),
        },
        'Đã tải số đầu kỳ QC'
    );
};

export const createManualProductionQcOpeningBalance = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const entries = await resolveManualEntries(plant.id, req.body.entries || []);
    const batch = await createConfirmedBatch({
        req,
        plant,
        cutoffDate: req.body.cutoffDate,
        note: String(req.body.note || '').trim(),
        entries,
        sourceType: 'manual',
    });
    return sendSuccess(res, serializeProductionQcOpeningBatch(batch), 'Đã xác nhận số đầu kỳ QC', StatusCodes.CREATED);
};

export const previewProductionQcOpeningImport = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const productionOpening = await assertCutoffCompatible(plant.id, req.body.cutoffDate);
    const preview = await loadWorkbookPreview(req, plant.id);
    const reconciliation = reconcileEntries(preview.entries, productionOpening.entries);
    return sendSuccess(
        res,
        {
            plant,
            cutoffDate: req.body.cutoffDate,
            fileName: req.file?.originalname,
            sheetName: preview.sheetName,
            headerRow: preview.headerRow,
            summary: { ...preview.summary, reconciliationInvalidCount: reconciliation.invalidCount },
            rows: preview.rows,
            reconciliation: reconciliation.rows,
        },
        preview.summary.invalidRows || reconciliation.invalidCount
            ? 'File còn dòng cần kiểm tra'
            : 'File QC đầu kỳ hợp lệ và sẵn sàng xác nhận'
    );
};

export const confirmProductionQcOpeningImport = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const preview = await loadWorkbookPreview(req, plant.id);
    if (preview.summary.invalidRows) {
        throw new BadRequestError(`Còn ${preview.summary.invalidRows} dòng lỗi, không thể xác nhận một phần`);
    }
    const batch = await createConfirmedBatch({
        req,
        plant,
        cutoffDate: req.body.cutoffDate,
        note: String(req.body.note || '').trim(),
        entries: preview.entries,
        sourceType: 'excel',
        file: req.file,
        sourceSheet: preview.sheetName,
    });
    return sendSuccess(res, serializeProductionQcOpeningBatch(batch), 'Đã nhập số đầu kỳ QC', StatusCodes.CREATED);
};

export const voidProductionQcOpeningBalance = async (req: Request, res: Response) => {
    const batch: any = await ProductionQcOpeningBalanceBatch.findById(req.params.id);
    if (!batch) throw new NotFoundError('Không tìm thấy batch QC đầu kỳ');
    assertPlantAccess(req, String(batch.plantId));
    if (batch.status === 'voided') throw new BadRequestError('Batch này đã được hủy trước đó');
    if (!req.userId) throw new UnAuthorizedError('Phiên đăng nhập không hợp lệ');
    batch.status = 'voided';
    batch.voidedBy = req.userId;
    batch.voidedAt = new Date();
    batch.voidReason = String(req.body.reason || '').trim();
    batch.history.push({ type: 'voided', reason: batch.voidReason, actor: req.userId, at: batch.voidedAt });
    await batch.save();
    await batch.populate(BATCH_ACTOR_PATHS);
    emitToPlant(String(batch.plantId), 'production:updated', {
        plantId: String(batch.plantId),
        changeType: 'qc-opening-balance-voided',
        batchId: String(batch._id),
        actorId: req.userId,
    });
    return sendSuccess(res, serializeProductionQcOpeningBatch(batch), 'Đã hủy batch QC đầu kỳ');
};

export const downloadProductionQcOpeningTemplate = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Production';
    workbook.company = 'Công ty TNHH May Xuất Khẩu Hải Đăng';
    const sheet = workbook.addWorksheet('QC đầu kỳ');
    sheet.columns = [
        { header: 'Mã chuyền (*)', key: 'lineCode', width: 18 },
        { header: 'Mã hàng', key: 'itemCode', width: 20 },
        { header: 'Mã đơn hàng', key: 'orderCode', width: 22 },
        { header: 'Chế độ dữ liệu', key: 'mode', width: 22 },
        { header: 'QC đạt đầu kỳ', key: 'passed', width: 20 },
        { header: 'QC lỗi đầu kỳ', key: 'defect', width: 20 },
        { header: 'Chưa kiểm đầu kỳ (*)', key: 'pending', width: 24 },
    ];
    const header = sheet.getRow(1);
    header.height = 30;
    header.eachCell((cell) => {
        cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B87' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    sheet.addRow(['CM1', 'MH-001', 'DH-2026-001', 'Đầy đủ', 9000, 150, 3350]);
    sheet.addRow(['CM2', 'MH-002', '', 'Chỉ biết tồn', 0, 0, 1800]);
    sheet.autoFilter = 'A1:G3';
    sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
    const guide = workbook.addWorksheet('Hướng dẫn');
    guide.getColumn(1).width = 110;
    [
        `MẪU SỐ ĐẦU KỲ QC - ${plant.name}`,
        '',
        'Ngày chốt QC phải trùng ngày chốt sản lượng đầu kỳ.',
        'Đầy đủ: QC đạt + QC lỗi + Chưa kiểm phải bằng sản lượng đầu kỳ cùng chuyền/mã hàng/đơn hàng.',
        'Chỉ biết tồn: chỉ nhập số Chưa kiểm; tỷ lệ chất lượng lịch sử sẽ được đánh dấu chưa đầy đủ.',
        'Bỏ trống mã hàng chỉ dùng khi dữ liệu lịch sử chưa thể phân bổ và sẽ làm giảm độ phủ báo cáo.',
        'Hệ thống chỉ xác nhận khi toàn bộ dòng hợp lệ.',
    ].forEach((text, index) => {
        const row = guide.addRow([text]);
        row.getCell(1).alignment = { vertical: 'top', wrapText: true };
        if (index === 0) row.getCell(1).font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF176B87' } };
    });
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="production-qc-opening-${plant.code || plant.id}.xlsx"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};
