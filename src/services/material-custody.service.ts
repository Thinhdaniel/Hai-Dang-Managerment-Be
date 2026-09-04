import { USER_ROLE } from '@/constant/allowedRoles';
import {
    MATERIAL_CUSTODY_ASSIGNMENT_STATUS,
    MATERIAL_CUSTODY_CAMPAIGN_STATUS,
    MATERIAL_CUSTODY_HOLDER_TYPE,
    MATERIAL_CUSTODY_MOVEMENT_TYPE,
    MATERIAL_CUSTODY_RESOLUTION,
    MATERIAL_CUSTODY_SOURCE_TYPE,
    MATERIAL_REUSE_TRACKING_MODE,
} from '@/constant/materialCustody';
import { BadRequestError, DuplicateError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Material from '@/models/Material';
import MaterialCustodyAssignment from '@/models/MaterialCustodyAssignment';
import MaterialCustodyMovement from '@/models/MaterialCustodyMovement';
import MaterialRecipient from '@/models/MaterialRecipient';
import MaterialUsageCampaign from '@/models/MaterialUsageCampaign';
import Plant from '@/models/Plant';
import ProductionItem from '@/models/ProductionItem';
import ReusableMaterialStock from '@/models/ReusableMaterialStock';
import { generateDocumentCode, getUserPlantId, toId } from '@/services/material-workflow.helpers';
import { notifyAdmins } from '@/services/notification.helper';
import { buildPaginatedResponse, getPagination } from '@/utils/pagination';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { buildMaterialCustodyWorkbook } from '@/utils/generateMaterialCustodyXlsx';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose, { ClientSession } from 'mongoose';

const EPSILON = 0.000001;
const GLOBAL_ROLES = new Set<string>([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR]);

const parseDate = (value?: string | Date | null) => {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestError('Thoi gian khong hop le');
    return parsed;
};

const toIso = (value?: Date | string | null) => (value ? new Date(value).toISOString() : undefined);

const getOutstanding = (assignment: any) =>
    Math.max(
        0,
        Number(assignment.quantityIssued || 0) -
            Number(assignment.quantityReturnedUsable || 0) -
            Number(assignment.quantityReturnedRepair || 0) -
            Number(assignment.quantityReturnedDamaged || 0) -
            Number(assignment.quantityLost || 0) -
            Number(assignment.quantityTransferred || 0)
    );

const resolutionTotalExpression = {
    $add: [
        { $ifNull: ['$quantityReturnedUsable', 0] },
        { $ifNull: ['$quantityReturnedRepair', 0] },
        { $ifNull: ['$quantityReturnedDamaged', 0] },
        { $ifNull: ['$quantityLost', 0] },
        { $ifNull: ['$quantityTransferred', 0] },
    ],
};

const outstandingExpression = {
    $max: [0, { $subtract: [{ $ifNull: ['$quantityIssued', 0] }, resolutionTotalExpression] }],
};

const resolvePlantId = (req: Request, requestedPlantId?: unknown) => {
    const ownPlantId = getUserPlantId(req);
    const requested = requestedPlantId ? String(requestedPlantId) : '';
    if (requested && GLOBAL_ROLES.has(String(req.role))) return requested;
    if (requested && ownPlantId && requested !== ownPlantId) {
        throw new UnAuthorizedError('Ban khong co quyen thao tac du lieu cua co so khac');
    }
    if (!ownPlantId) throw new BadRequestError('Nguoi dung chua duoc gan co so');
    return ownPlantId;
};

const assertPlantAccess = (req: Request, plantId: unknown) => {
    const targetPlantId = String(plantId || '');
    if (GLOBAL_ROLES.has(String(req.role))) return;
    if (!targetPlantId || targetPlantId !== getUserPlantId(req)) {
        throw new UnAuthorizedError('Ban khong co quyen thao tac du lieu cua co so khac');
    }
};

const serializeRecipient = (input: any) => ({
    id: toId(input),
    employeeCode: input.employeeCode,
    fullName: input.fullName,
    plantId: toId(input.plantId),
    department: input.department,
    lineName: input.lineName,
    phone: input.phone,
    isActive: input.isActive !== false,
    createdAt: toIso(input.createdAt),
    updatedAt: toIso(input.updatedAt),
});

const serializeCampaign = (input: any, stats?: any) => ({
    id: toId(input),
    campaignCode: input.campaignCode,
    plantId: toId(input.plantId),
    productionItemId: toId(input.productionItemId),
    itemCode: input.itemCode,
    itemName: input.itemName,
    orderCode: input.orderCode,
    status: input.status,
    startedAt: toIso(input.startedAt),
    recallOpenedAt: toIso(input.recallOpenedAt),
    dueAt: toIso(input.dueAt),
    closedAt: toIso(input.closedAt),
    note: input.note,
    assignmentCount: Number(stats?.assignmentCount || 0),
    issuedQuantity: Number(stats?.issuedQuantity || 0),
    outstandingQuantity: Number(stats?.outstandingQuantity || 0),
    holderCount: Number(stats?.holderCount || 0),
    createdAt: toIso(input.createdAt),
    updatedAt: toIso(input.updatedAt),
});

const serializeAssignment = (input: any) => {
    const outstandingQuantity = getOutstanding(input);
    return {
        id: toId(input),
        plantId: toId(input.plantId),
        materialId: toId(input.materialId),
        materialCode: input.materialCode,
        materialName: input.materialName,
        unit: input.unit,
        trackingMode: input.trackingMode,
        holderType: input.holderType,
        recipientId: toId(input.recipientId),
        holderCode: input.holderCode,
        holderName: input.holderName,
        department: input.department,
        lineName: input.lineName,
        campaignId: toId(input.campaignId),
        productionItemId: toId(input.productionItemId),
        itemCode: input.itemCode,
        itemName: input.itemName,
        orderCode: input.orderCode,
        sourceType: input.sourceType,
        sourceDistributionId: toId(input.sourceDistributionId),
        sourceDistributionItemIndex: input.sourceDistributionItemIndex,
        sourceAssignmentId: toId(input.sourceAssignmentId),
        quantityIssued: Number(input.quantityIssued || 0),
        quantityReturnedUsable: Number(input.quantityReturnedUsable || 0),
        quantityReturnedRepair: Number(input.quantityReturnedRepair || 0),
        quantityReturnedDamaged: Number(input.quantityReturnedDamaged || 0),
        quantityLost: Number(input.quantityLost || 0),
        quantityTransferred: Number(input.quantityTransferred || 0),
        outstandingQuantity,
        unitPrice: Number(input.unitPrice || 0),
        outstandingValue: Number((outstandingQuantity * Number(input.unitPrice || 0)).toFixed(2)),
        status: input.status,
        issuedAt: toIso(input.issuedAt),
        dueAt: toIso(input.dueAt),
        resolvedAt: toIso(input.resolvedAt),
        overdue: outstandingQuantity > EPSILON && input.dueAt ? new Date(input.dueAt).getTime() < Date.now() : false,
        note: input.note,
        createdAt: toIso(input.createdAt),
        updatedAt: toIso(input.updatedAt),
    };
};

const serializeMovement = (input: any) => ({
    id: toId(input),
    assignmentId: toId(input.assignmentId),
    campaignId: toId(input.campaignId),
    materialId: toId(input.materialId),
    recipientId: toId(input.recipientId),
    type: input.type,
    resolution: input.resolution,
    quantity: Number(input.quantity || 0),
    note: input.note,
    evidenceUrls: input.evidenceUrls || [],
    performedBy: toId(input.performedBy),
    occurredAt: toIso(input.occurredAt),
    createdAt: toIso(input.createdAt),
});

const resolveHolder = async ({
    holderType,
    recipientId,
    holderName,
    holderCode,
    department,
    lineName,
    plantId,
    session,
}: any) => {
    if (holderType === MATERIAL_CUSTODY_HOLDER_TYPE.EMPLOYEE) {
        if (!recipientId) throw new BadRequestError('Vui long chon cong nhan nhan vat tu tai su dung');
        const recipient = await MaterialRecipient.findOne({
            _id: recipientId,
            plantId,
            isDeleted: { $ne: true },
            isActive: { $ne: false },
        }).session(session || null);
        if (!recipient) throw new NotFoundError('Khong tim thay cong nhan dang hoat dong tai co so');
        return {
            holderType,
            recipientId: recipient._id,
            holderCode: recipient.employeeCode,
            holderName: recipient.fullName,
            department: recipient.department,
            lineName: recipient.lineName,
        };
    }

    if (holderType !== MATERIAL_CUSTODY_HOLDER_TYPE.TEAM) {
        throw new BadRequestError('Vui long chon cap cho cong nhan hoac cap cho to/chuyen');
    }
    const resolvedName = String(holderName || lineName || department || '').trim();
    if (!resolvedName) throw new BadRequestError('Vui long nhap ten to/chuyen nhan vat tu');
    return {
        holderType,
        holderCode: String(holderCode || '').trim() || undefined,
        holderName: resolvedName,
        department: String(department || '').trim() || undefined,
        lineName: String(lineName || '').trim() || undefined,
    };
};

const resolveCampaign = async (campaignId: string, plantId: string, session?: ClientSession) => {
    const query = MaterialUsageCampaign.findOne({
        _id: campaignId,
        plantId,
        status: MATERIAL_CUSTODY_CAMPAIGN_STATUS.ACTIVE,
        isDeleted: { $ne: true },
    });
    if (session) query.session(session);
    const campaign = await query;
    if (!campaign) throw new BadRequestError('Dot su dung vat tu khong ton tai, da thu hoi hoac da dong');
    return campaign;
};

const calculateDueAt = (explicitDueAt: any, issuedAt: Date, defaultReturnDays: number) => {
    if (explicitDueAt) return new Date(explicitDueAt);
    if (!defaultReturnDays) return undefined;
    const dueAt = new Date(issuedAt);
    dueAt.setDate(dueAt.getDate() + defaultReturnDays);
    return dueAt;
};

const createAssignmentWithMovement = async ({ assignmentData, performedBy, session }: any) => {
    const assignment = new MaterialCustodyAssignment({
        ...assignmentData,
        createdBy: performedBy,
        updatedBy: performedBy,
    });
    await assignment.save({ session });
    await MaterialCustodyMovement.create(
        [
            {
                plantId: assignment.plantId,
                assignmentId: assignment._id,
                campaignId: assignment.campaignId,
                materialId: assignment.materialId,
                recipientId: assignment.recipientId,
                type: MATERIAL_CUSTODY_MOVEMENT_TYPE.ISSUE,
                quantity: assignment.quantityIssued,
                note: assignment.note,
                performedBy,
                occurredAt: assignment.issuedAt,
            },
        ],
        { session }
    );
    return assignment;
};

export const registerInitialCustodyAssignments = async ({
    record,
    items,
    performedBy,
    session,
}: {
    record: any;
    items: any[];
    performedBy: string;
    session: ClientSession;
}) => {
    const trackedItems = items
        .map((item, index) => ({ item, index }))
        .filter(
            ({ item }) =>
                item.reuseTrackingMode &&
                item.reuseTrackingMode !== MATERIAL_REUSE_TRACKING_MODE.NONE &&
                Number(item.quantity || 0) > 0
        );
    if (!trackedItems.length) return items;

    const plantId = toId(record.fromPlantId);
    if (!plantId) throw new BadRequestError('Phieu cap phat chua co co so xuat');
    if (!record.usageCampaignId) throw new BadRequestError('Vat tu tai su dung bat buoc gan dot ma hang');

    const campaign = await resolveCampaign(String(record.usageCampaignId), plantId, session);
    const holder = await resolveHolder({
        holderType: record.holderType,
        recipientId: record.recipientId,
        holderName: record.holderName || record.requesterName,
        holderCode: record.holderCode,
        department: record.targetDepartment,
        lineName: record.targetLine,
        plantId,
        session,
    });
    const materialIds = trackedItems.map(({ item }) => item.materialId).filter(Boolean);
    const materials = await Material.find({ _id: { $in: materialIds }, isDeleted: { $ne: true } }).session(session);
    const materialById = new Map(materials.map((material: any) => [String(material._id), material]));
    const issuedAt = record.distributedAt ? new Date(record.distributedAt) : new Date();
    const output = items.map((item) => ({ ...(item.toObject ? item.toObject() : item) }));

    for (const { item, index } of trackedItems) {
        const material = materialById.get(String(item.materialId));
        if (!material) throw new NotFoundError(`Khong tim thay vat tu tai su dung "${item.materialName || ''}"`);
        if (
            item.reuseTrackingMode === MATERIAL_REUSE_TRACKING_MODE.SERIALIZED &&
            !Number.isInteger(Number(item.quantity))
        ) {
            throw new BadRequestError(
                `Vat tu "${item.materialName}" theo doi tung chiec nen so luong phai la so nguyen`
            );
        }
        const assignment = await createAssignmentWithMovement({
            assignmentData: {
                plantId,
                materialId: material._id,
                materialCode: material.code,
                materialName: item.materialName || material.name,
                unit: item.unit || material.unit,
                trackingMode: item.reuseTrackingMode,
                ...holder,
                campaignId: campaign._id,
                productionItemId: campaign.productionItemId,
                itemCode: campaign.itemCode,
                itemName: campaign.itemName,
                orderCode: campaign.orderCode,
                sourceType: MATERIAL_CUSTODY_SOURCE_TYPE.NEW_STOCK,
                sourceDistributionId: record._id,
                sourceDistributionItemIndex: index,
                quantityIssued: Number(item.quantity),
                unitPrice: Number(item.unitPrice || 0),
                issuedAt,
                dueAt: calculateDueAt(record.expectedReturnAt, issuedAt, Number(material.defaultReturnDays || 0)),
                note: item.note,
            },
            performedBy,
            session,
        });
        output[index].custodyAssignmentId = assignment._id;
    }
    return output;
};

export const listRecipients = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const filter: Record<string, any> = { plantId, isDeleted: { $ne: true } };
    if (req.query.isActive !== undefined) filter.isActive = String(req.query.isActive) === 'true';
    const regex = buildSearchRegex(req.query.search, { flexibleWhitespace: true });
    if (regex) filter.$or = [{ employeeCode: regex }, { fullName: regex }, { department: regex }, { lineName: regex }];
    const [rows, total] = await Promise.all([
        MaterialRecipient.find(filter)
            .sort({ isActive: -1, fullName: 1 })
            .skip(skip)
            .limit(Math.min(limit, 200))
            .lean(),
        MaterialRecipient.countDocuments(filter),
    ]);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(rows.map(serializeRecipient), total, page, Math.min(limit, 200)),
            message: 'Lay danh sach nguoi nhan vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createRecipient = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    try {
        const recipient = await MaterialRecipient.create({
            ...req.body,
            employeeCode: String(req.body.employeeCode).trim().toUpperCase(),
            fullName: String(req.body.fullName).trim(),
            plantId,
            createdBy: req.userId,
            updatedBy: req.userId,
        });
        return res.status(StatusCodes.CREATED).json(
            customResponse({
                data: serializeRecipient(recipient),
                message: 'Da them nguoi nhan vat tu',
                status: StatusCodes.CREATED,
                success: true,
            })
        );
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Ma cong nhan da ton tai trong co so');
        throw error;
    }
};

export const updateRecipient = async (req: Request, res: Response, _next: NextFunction) => {
    const recipient = await MaterialRecipient.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!recipient) throw new NotFoundError('Khong tim thay nguoi nhan vat tu');
    assertPlantAccess(req, recipient.plantId);
    Object.assign(recipient, req.body, {
        ...(req.body.employeeCode ? { employeeCode: String(req.body.employeeCode).trim().toUpperCase() } : {}),
        ...(req.body.fullName ? { fullName: String(req.body.fullName).trim() } : {}),
        updatedBy: req.userId,
    });
    try {
        await recipient.save();
    } catch (error: any) {
        if (error?.code === 11000) throw new DuplicateError('Ma cong nhan da ton tai trong co so');
        throw error;
    }
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeRecipient(recipient),
            message: 'Da cap nhat nguoi nhan vat tu',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

type RecipientImportRow = {
    rowNumber: number;
    isValid: boolean;
    action?: 'create' | 'update';
    values: {
        employeeCode: string;
        fullName: string;
        department: string;
        lineName: string;
        phone: string;
        isActive: boolean;
    };
    errors: string[];
};

const parseRecipientImportRows = async (fileBuffer: Buffer, plantId: string): Promise<RecipientImportRow[]> => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as any);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new BadRequestError('File Excel khong hop le');
    const normalizeHeader = (value: string) =>
        value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    const requiredHeaders = ['macongnhan', 'hoten'];
    requiredHeaders.forEach((expected, index) => {
        if (!normalizeHeader(String(worksheet.getRow(1).getCell(index + 1).text || '')).startsWith(expected)) {
            throw new BadRequestError('File khong dung mau nguoi nhan vat tu cua he thong');
        }
    });
    const rows: RecipientImportRow[] = [];

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const employeeCode = String(row.getCell(1).text || '')
            .trim()
            .toUpperCase();
        const fullName = String(row.getCell(2).text || '').trim();
        const department = String(row.getCell(3).text || '').trim();
        const lineName = String(row.getCell(4).text || '').trim();
        const phone = String(row.getCell(5).text || '').trim();
        const statusText = String(row.getCell(6).text || '')
            .trim()
            .toLocaleLowerCase('vi-VN');
        if (!employeeCode && !fullName && !department && !lineName && !phone) return;
        const errors: string[] = [];
        if (!employeeCode) errors.push('Thiếu mã công nhân');
        if (!fullName) errors.push('Thiếu họ tên');
        if (employeeCode.length > 60) errors.push('Mã công nhân dài quá 60 ký tự');
        if (fullName.length > 160) errors.push('Họ tên dài quá 160 ký tự');
        const inactiveValues = new Set(['đã nghỉ', 'nghỉ', 'inactive', 'không', 'no', '0', 'false']);
        rows.push({
            rowNumber,
            isValid: errors.length === 0,
            values: {
                employeeCode,
                fullName,
                department,
                lineName,
                phone,
                isActive: !inactiveValues.has(statusText),
            },
            errors,
        });
    });
    if (!rows.length) throw new BadRequestError('File khong co dong du lieu');

    const codeCounts = new Map<string, number>();
    rows.forEach((row) => {
        if (row.values.employeeCode)
            codeCounts.set(row.values.employeeCode, (codeCounts.get(row.values.employeeCode) || 0) + 1);
    });
    rows.forEach((row) => {
        if (row.values.employeeCode && (codeCounts.get(row.values.employeeCode) || 0) > 1) {
            row.errors.push('Mã công nhân bị trùng trong file');
            row.isValid = false;
        }
    });

    const codes = rows.filter((row) => row.isValid).map((row) => row.values.employeeCode);
    const existingCodes = codes.length
        ? new Set(
              (
                  await MaterialRecipient.find({ plantId, employeeCode: { $in: codes }, isDeleted: { $ne: true } })
                      .select('employeeCode')
                      .lean()
              ).map((row: any) => row.employeeCode)
          )
        : new Set<string>();
    rows.forEach((row) => {
        if (row.isValid) row.action = existingCodes.has(row.values.employeeCode) ? 'update' : 'create';
    });
    return rows;
};

const recipientImportSummary = (rows: RecipientImportRow[]) => ({
    totalRows: rows.length,
    validRows: rows.filter((row) => row.isValid).length,
    invalidRows: rows.filter((row) => !row.isValid).length,
    toCreate: rows.filter((row) => row.action === 'create').length,
    toUpdate: rows.filter((row) => row.action === 'update').length,
});

export const downloadRecipientImportTemplate = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const plant = await Plant.findById(plantId).select('name code').lean();
    if (!plant) throw new NotFoundError('Khong tim thay co so');
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hải Đăng Management System';
    const worksheet = workbook.addWorksheet('Người nhận vật tư');
    worksheet.columns = [
        { header: 'Mã công nhân (*)', key: 'employeeCode', width: 21 },
        { header: 'Họ tên (*)', key: 'fullName', width: 30 },
        { header: 'Bộ phận', key: 'department', width: 22 },
        { header: 'Chuyền / tổ', key: 'lineName', width: 22 },
        { header: 'Số điện thoại', key: 'phone', width: 18 },
        { header: 'Trạng thái', key: 'status', width: 18 },
    ];
    worksheet.addRow({
        employeeCode: 'CN001',
        fullName: 'Nguyễn Văn A',
        department: 'Sản xuất',
        lineName: 'Chuyền CM1',
        phone: '09xxxxxxxx',
        status: 'Đang làm việc',
    });
    worksheet.addRow({
        employeeCode: 'CN002',
        fullName: 'Trần Thị B',
        department: 'Sản xuất',
        lineName: 'Chuyền CM2',
        phone: '',
        status: 'Đang làm việc',
    });
    const header = worksheet.getRow(1);
    header.height = 28;
    header.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = 'A1:F1';
    worksheet.getColumn(6).eachCell((cell, rowNumber) => {
        if (rowNumber > 1)
            cell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"Đang làm việc,Đã nghỉ"'] };
    });
    const note = workbook.addWorksheet('Hướng dẫn');
    note.columns = [{ width: 28 }, { width: 76 }];
    note.addRows([
        ['Cơ sở nhập', `${(plant as any).name} (${(plant as any).code})`],
        ['Quy tắc', 'Mã công nhân là duy nhất trong một cơ sở. Mã đã có sẽ được cập nhật, mã mới sẽ được tạo.'],
        ['Bắt buộc', 'Mã công nhân và Họ tên. Không đổi tên hoặc thứ tự các cột của sheet đầu tiên.'],
        ['Trạng thái', 'Để trống hoặc nhập “Đang làm việc”; nhập “Đã nghỉ” để vô hiệu hóa người nhận.'],
    ]);
    note.getColumn(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="mau-nguoi-nhan-vat-tu.xlsx"');
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};

export const previewRecipientImport = async (req: Request, res: Response, _next: NextFunction) => {
    if (!req.file?.buffer) throw new BadRequestError('Vui long chon file Excel');
    if (!/\.xlsx$/i.test(req.file.originalname)) throw new BadRequestError('Vui long dung file XLSX theo mau he thong');
    const plantId = resolvePlantId(req, req.body.plantId);
    const rows = await parseRecipientImportRows(req.file.buffer, plantId);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { summary: recipientImportSummary(rows), rows },
            message: 'Xem truoc danh sach nguoi nhan thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const confirmRecipientImport = async (req: Request, res: Response, _next: NextFunction) => {
    if (!req.file?.buffer) throw new BadRequestError('Vui long chon file Excel');
    if (!/\.xlsx$/i.test(req.file.originalname)) throw new BadRequestError('Vui long dung file XLSX theo mau he thong');
    const plantId = resolvePlantId(req, req.body.plantId);
    const rows = await parseRecipientImportRows(req.file.buffer, plantId);
    const validRows = rows.filter((row) => row.isValid && row.action);
    if (!validRows.length) throw new BadRequestError('File khong co dong hop le de import');
    const operations: any[] = validRows.map((row) => ({
        updateOne: {
            filter: { plantId, employeeCode: row.values.employeeCode, isDeleted: { $ne: true } },
            update: {
                $set: {
                    fullName: row.values.fullName,
                    department: row.values.department || undefined,
                    lineName: row.values.lineName || undefined,
                    phone: row.values.phone || undefined,
                    isActive: row.values.isActive,
                    updatedBy: req.userId,
                },
                $setOnInsert: {
                    plantId,
                    employeeCode: row.values.employeeCode,
                    createdBy: req.userId,
                    isDeleted: false,
                },
            },
            upsert: true,
        },
    }));
    await MaterialRecipient.bulkWrite(operations, { ordered: false });
    const summary = recipientImportSummary(rows);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                created: summary.toCreate,
                updated: summary.toUpdate,
                errors: summary.invalidRows,
                total: summary.totalRows,
            },
            message: `Da import ${summary.validRows} nguoi nhan`,
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const listProductionItemReferences = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const filter: Record<string, any> = { plantId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    const regex = buildSearchRegex(req.query.search, { flexibleWhitespace: true });
    if (regex) filter.$or = [{ code: regex }, { name: regex }];
    const items = await ProductionItem.find(filter).sort({ isActive: -1, code: 1 }).limit(200).lean();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: items.map((item: any) => ({
                id: toId(item),
                code: item.code,
                name: item.name,
                isActive: item.isActive !== false,
            })),
            message: 'Lay danh muc ma hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const listTrackedMaterialReferences = async (_req: Request, res: Response, _next: NextFunction) => {
    const materials = await Material.find({
        isDeleted: { $ne: true },
        isActive: { $ne: false },
        reuseTrackingMode: { $in: [MATERIAL_REUSE_TRACKING_MODE.QUANTITY, MATERIAL_REUSE_TRACKING_MODE.SERIALIZED] },
    })
        .select('code name unit reuseTrackingMode defaultReturnDays')
        .sort({ name: 1 })
        .limit(1000)
        .lean();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: materials.map((material: any) => ({
                id: toId(material),
                code: material.code,
                name: material.name,
                unit: material.unit,
                trackingMode: material.reuseTrackingMode,
                defaultReturnDays: Number(material.defaultReturnDays || 0),
            })),
            message: 'Lay danh muc vat tu can thu hoi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createCampaign = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    let productionItem: any;
    if (req.body.productionItemId) {
        productionItem = await ProductionItem.findOne({ _id: req.body.productionItemId, plantId });
        if (!productionItem) throw new NotFoundError('Khong tim thay ma hang tai co so');
    }
    const itemCode = String(productionItem?.code || req.body.itemCode || '')
        .trim()
        .toUpperCase();
    if (!itemCode) throw new BadRequestError('Vui long chon hoac nhap ma hang');
    const orderCode =
        String(req.body.orderCode || '')
            .trim()
            .toUpperCase() || undefined;
    const duplicate = await MaterialUsageCampaign.findOne({
        plantId,
        itemCode,
        orderCode: orderCode || { $in: [null, ''] },
        status: { $in: [MATERIAL_CUSTODY_CAMPAIGN_STATUS.ACTIVE, MATERIAL_CUSTODY_CAMPAIGN_STATUS.RECALLING] },
        isDeleted: { $ne: true },
    }).lean();
    if (duplicate) throw new DuplicateError('Ma hang nay dang co mot dot su dung chua dong');
    const campaignCode = await generateDocumentCode({
        model: MaterialUsageCampaign,
        field: 'campaignCode',
        prefix: 'DTSD',
    });
    const campaign = await MaterialUsageCampaign.create({
        campaignCode,
        plantId,
        productionItemId: productionItem?._id,
        itemCode,
        itemName: productionItem?.name || String(req.body.itemName || '').trim() || undefined,
        orderCode,
        startedAt: parseDate(req.body.startedAt) || new Date(),
        note: req.body.note?.trim() || undefined,
        createdBy: req.userId,
    });
    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeCampaign(campaign),
            message: 'Da mo dot su dung vat tu',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const listCampaigns = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const effectiveLimit = Math.min(limit, 100);
    const filter: Record<string, any> = { plantId, isDeleted: { $ne: true } };
    if (req.query.status) filter.status = String(req.query.status);
    const regex = buildSearchRegex(req.query.search, { flexibleWhitespace: true });
    if (regex) filter.$or = [{ campaignCode: regex }, { itemCode: regex }, { itemName: regex }, { orderCode: regex }];
    const [campaigns, total] = await Promise.all([
        MaterialUsageCampaign.find(filter).sort({ startedAt: -1 }).skip(skip).limit(effectiveLimit).lean(),
        MaterialUsageCampaign.countDocuments(filter),
    ]);
    const ids = campaigns.map((campaign: any) => campaign._id);
    const stats = ids.length
        ? await MaterialCustodyAssignment.aggregate([
              { $match: { campaignId: { $in: ids }, isDeleted: { $ne: true } } },
              {
                  $group: {
                      _id: '$campaignId',
                      assignmentCount: { $sum: 1 },
                      issuedQuantity: { $sum: '$quantityIssued' },
                      outstandingQuantity: { $sum: outstandingExpression },
                      holders: { $addToSet: { $ifNull: ['$recipientId', '$holderName'] } },
                  },
              },
              {
                  $project: {
                      assignmentCount: 1,
                      issuedQuantity: 1,
                      outstandingQuantity: 1,
                      holderCount: { $size: '$holders' },
                  },
              },
          ])
        : [];
    const statsById = new Map(stats.map((row: any) => [String(row._id), row]));
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(
                campaigns.map((campaign: any) => serializeCampaign(campaign, statsById.get(String(campaign._id)))),
                total,
                page,
                effectiveLimit
            ),
            message: 'Lay danh sach dot su dung vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const openRecall = async (req: Request, res: Response, _next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let campaign: any;
    try {
        campaign = await MaterialUsageCampaign.findOne({
            _id: req.params.id,
            status: MATERIAL_CUSTODY_CAMPAIGN_STATUS.ACTIVE,
            isDeleted: { $ne: true },
        }).session(session);
        if (!campaign) throw new BadRequestError('Dot su dung khong ton tai hoac khong o trang thai dang su dung');
        assertPlantAccess(req, campaign.plantId);
        const dueAt = new Date(req.body.dueAt);
        if (Number.isNaN(dueAt.getTime())) throw new BadRequestError('Han thu hoi khong hop le');
        if (dueAt.getTime() < Date.now()) throw new BadRequestError('Han thu hoi khong duoc nam trong qua khu');
        campaign.status = MATERIAL_CUSTODY_CAMPAIGN_STATUS.RECALLING;
        campaign.recallOpenedAt = new Date();
        campaign.recallOpenedBy = req.userId as any;
        campaign.dueAt = dueAt;
        if (req.body.note) campaign.note = req.body.note.trim();
        await campaign.save({ session });
        await MaterialCustodyAssignment.updateMany(
            {
                campaignId: campaign._id,
                status: {
                    $in: [MATERIAL_CUSTODY_ASSIGNMENT_STATUS.ACTIVE, MATERIAL_CUSTODY_ASSIGNMENT_STATUS.PARTIAL],
                },
                isDeleted: { $ne: true },
            },
            { $set: { status: MATERIAL_CUSTODY_ASSIGNMENT_STATUS.RECALL_DUE, dueAt, updatedBy: req.userId } },
            { session }
        );
        await session.commitTransaction();
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
    void notifyAdmins(
        'notify:new',
        {
            type: 'warning',
            actionType: 'material_custody',
            actionId: String(campaign._id),
            title: `Thu hồi CCDC mã hàng ${campaign.itemCode}`,
            message: `Đợt ${campaign.campaignCode} đã kết thúc sử dụng. Hạn thu hồi ${new Date(campaign.dueAt).toLocaleDateString('vi-VN')}.`,
        },
        { excludeUserIds: [req.userId] }
    );
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeCampaign(campaign),
            message: 'Da mo thu hoi vat tu theo ma hang',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const closeCampaign = async (req: Request, res: Response, _next: NextFunction) => {
    const campaign = await MaterialUsageCampaign.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!campaign) throw new NotFoundError('Khong tim thay dot su dung vat tu');
    assertPlantAccess(req, campaign.plantId);
    if (campaign.status !== MATERIAL_CUSTODY_CAMPAIGN_STATUS.RECALLING) {
        throw new BadRequestError('Chi co the dong dot dang thu hoi');
    }
    const unresolved = await MaterialCustodyAssignment.countDocuments({
        campaignId: campaign._id,
        isDeleted: { $ne: true },
        $expr: { $gt: [outstandingExpression, EPSILON] },
    });
    if (unresolved > 0) throw new BadRequestError(`Con ${unresolved} dong vat tu chua thu hoi hoac xu ly chenh lech`);
    campaign.status = MATERIAL_CUSTODY_CAMPAIGN_STATUS.CLOSED;
    campaign.closedAt = new Date();
    campaign.closedBy = req.userId as any;
    await campaign.save();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeCampaign(campaign),
            message: 'Da dong dot thu hoi vat tu',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const listAssignments = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const { page, limit, skip } = getPagination(req.query as Record<string, any>);
    const effectiveLimit = Math.min(limit, 200);
    const filter: Record<string, any> = { plantId, isDeleted: { $ne: true } };
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.campaignId) filter.campaignId = String(req.query.campaignId);
    if (req.query.recipientId) filter.recipientId = String(req.query.recipientId);
    if (req.query.materialId) filter.materialId = String(req.query.materialId);
    if (req.query.onlyOutstanding === 'true') filter.$expr = { $gt: [outstandingExpression, EPSILON] };
    const regex = buildSearchRegex(req.query.search, { flexibleWhitespace: true });
    if (regex) {
        filter.$or = [
            { materialCode: regex },
            { materialName: regex },
            { holderCode: regex },
            { holderName: regex },
            { department: regex },
            { lineName: regex },
            { itemCode: regex },
            { orderCode: regex },
        ];
    }
    const [rows, total] = await Promise.all([
        MaterialCustodyAssignment.find(filter)
            .sort({ status: 1, dueAt: 1, issuedAt: -1 })
            .skip(skip)
            .limit(effectiveLimit)
            .lean(),
        MaterialCustodyAssignment.countDocuments(filter),
    ]);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: buildPaginatedResponse(rows.map(serializeAssignment), total, page, effectiveLimit),
            message: 'Lay so theo doi vat tu dang su dung thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getAssignmentMovements = async (req: Request, res: Response, _next: NextFunction) => {
    const assignment = await MaterialCustodyAssignment.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
    if (!assignment) throw new NotFoundError('Khong tim thay dong vat tu dang su dung');
    assertPlantAccess(req, assignment.plantId);
    const movements = await MaterialCustodyMovement.find({ assignmentId: assignment._id })
        .sort({ occurredAt: -1 })
        .lean();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { assignment: serializeAssignment(assignment), movements: movements.map(serializeMovement) },
            message: 'Lay lich su cap thu hoi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const updateAssignmentResolution = (assignment: any, resolution: string, quantity: number) => {
    if (resolution === MATERIAL_CUSTODY_RESOLUTION.USABLE) assignment.quantityReturnedUsable += quantity;
    else if (resolution === MATERIAL_CUSTODY_RESOLUTION.REPAIR) assignment.quantityReturnedRepair += quantity;
    else if (resolution === MATERIAL_CUSTODY_RESOLUTION.DAMAGED) assignment.quantityReturnedDamaged += quantity;
    else if (resolution === MATERIAL_CUSTODY_RESOLUTION.LOST) assignment.quantityLost += quantity;
};

const refreshAssignmentStatus = (assignment: any, campaignStatus?: string) => {
    const outstanding = getOutstanding(assignment);
    if (outstanding <= EPSILON) {
        assignment.status = MATERIAL_CUSTODY_ASSIGNMENT_STATUS.RESOLVED;
        assignment.resolvedAt = new Date();
    } else if (campaignStatus === MATERIAL_CUSTODY_CAMPAIGN_STATUS.RECALLING) {
        assignment.status = MATERIAL_CUSTODY_ASSIGNMENT_STATUS.RECALL_DUE;
        assignment.resolvedAt = undefined;
    } else {
        assignment.status = MATERIAL_CUSTODY_ASSIGNMENT_STATUS.PARTIAL;
        assignment.resolvedAt = undefined;
    }
};

export const resolveAssignment = async (req: Request, res: Response, _next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let assignment: any;
    try {
        assignment = await MaterialCustodyAssignment.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).session(
            session
        );
        if (!assignment) throw new NotFoundError('Khong tim thay dong vat tu dang su dung');
        assertPlantAccess(req, assignment.plantId);
        const quantity = Number(req.body.quantity);
        const outstanding = getOutstanding(assignment);
        if (quantity > outstanding + EPSILON) {
            throw new BadRequestError(`So luong xu ly vuot so dang giu (${outstanding} ${assignment.unit})`);
        }
        updateAssignmentResolution(assignment, req.body.resolution, quantity);
        const campaign = await MaterialUsageCampaign.findById(assignment.campaignId).session(session);
        refreshAssignmentStatus(assignment, campaign?.status);
        assignment.updatedBy = req.userId as any;
        await assignment.save({ session });

        const poolIncrement: Record<string, number> = {};
        if (req.body.resolution === MATERIAL_CUSTODY_RESOLUTION.USABLE) poolIncrement.availableQuantity = quantity;
        if (req.body.resolution === MATERIAL_CUSTODY_RESOLUTION.REPAIR) poolIncrement.repairQuantity = quantity;
        if (req.body.resolution === MATERIAL_CUSTODY_RESOLUTION.DAMAGED) poolIncrement.damagedQuantity = quantity;
        if (Object.keys(poolIncrement).length) {
            await ReusableMaterialStock.updateOne(
                { plantId: assignment.plantId, materialId: assignment.materialId },
                {
                    $setOnInsert: { plantId: assignment.plantId, materialId: assignment.materialId },
                    $inc: poolIncrement,
                    $set: { lastMovementAt: parseDate(req.body.occurredAt) || new Date() },
                },
                { upsert: true, session }
            );
        }
        await MaterialCustodyMovement.create(
            [
                {
                    plantId: assignment.plantId,
                    assignmentId: assignment._id,
                    campaignId: assignment.campaignId,
                    materialId: assignment.materialId,
                    recipientId: assignment.recipientId,
                    type:
                        req.body.resolution === MATERIAL_CUSTODY_RESOLUTION.LOST
                            ? MATERIAL_CUSTODY_MOVEMENT_TYPE.LOSS
                            : MATERIAL_CUSTODY_MOVEMENT_TYPE.RETURN,
                    resolution: req.body.resolution,
                    quantity,
                    note: req.body.note?.trim() || undefined,
                    evidenceUrls: req.body.evidenceUrls || [],
                    performedBy: req.userId,
                    occurredAt: parseDate(req.body.occurredAt) || new Date(),
                },
            ],
            { session }
        );
        await session.commitTransaction();
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeAssignment(assignment),
            message: 'Da ghi nhan thu hoi hoac xu ly chenh lech',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const resolveTargetContext = async (body: any, plantId: string, session: ClientSession) => {
    const [campaign, holder] = await Promise.all([
        resolveCampaign(body.campaignId, plantId, session),
        resolveHolder({ ...body, plantId, session }),
    ]);
    return { campaign, holder };
};

export const createOpeningBalanceAssignment = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const session = await mongoose.startSession();
    session.startTransaction();
    let assignment: any;
    try {
        const material: any = await Material.findOne({
            _id: req.body.materialId,
            isDeleted: { $ne: true },
            isActive: { $ne: false },
            reuseTrackingMode: { $ne: MATERIAL_REUSE_TRACKING_MODE.NONE },
        }).session(session);
        if (!material) throw new BadRequestError('Vat tu khong ton tai hoac chua bat theo doi tai su dung');
        const quantity = Number(req.body.quantity);
        if (material.reuseTrackingMode === MATERIAL_REUSE_TRACKING_MODE.SERIALIZED && !Number.isInteger(quantity)) {
            throw new BadRequestError('Vat tu theo doi tung chiec nen so luong phai la so nguyen');
        }
        const { campaign, holder } = await resolveTargetContext(req.body, plantId, session);
        const issuedAt = parseDate(req.body.issuedAt) || new Date();
        if (issuedAt.getTime() > Date.now())
            throw new BadRequestError('Ngay cap dau ky khong duoc nam trong tuong lai');
        const dueAt = calculateDueAt(req.body.dueAt, issuedAt, Number(material.defaultReturnDays || 0));
        assignment = await createAssignmentWithMovement({
            assignmentData: {
                plantId,
                materialId: material._id,
                materialCode: material.code,
                materialName: material.name,
                unit: material.unit,
                trackingMode: material.reuseTrackingMode,
                ...holder,
                campaignId: campaign._id,
                productionItemId: campaign.productionItemId,
                itemCode: campaign.itemCode,
                itemName: campaign.itemName,
                orderCode: campaign.orderCode,
                sourceType: MATERIAL_CUSTODY_SOURCE_TYPE.OPENING_BALANCE,
                quantityIssued: quantity,
                unitPrice: Number(req.body.unitPrice || 0),
                issuedAt,
                dueAt,
                note: req.body.note?.trim() || 'Số dư đang giữ trước khi áp dụng chức năng theo dõi',
            },
            performedBy: req.userId,
            session,
        });
        await session.commitTransaction();
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeAssignment(assignment),
            message: 'Da ghi nhan so du dang giu dau ky, khong tru kho va khong phat sinh chi phi',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const reissueReusable = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.body.plantId);
    const session = await mongoose.startSession();
    session.startTransaction();
    let assignment: any;
    try {
        const quantity = Number(req.body.quantity);
        const material = await Material.findOne({
            _id: req.body.materialId,
            isDeleted: { $ne: true },
            reuseTrackingMode: { $ne: MATERIAL_REUSE_TRACKING_MODE.NONE },
        }).session(session);
        if (!material) throw new BadRequestError('Vat tu khong ton tai hoac chua bat theo doi tai su dung');
        if (material.reuseTrackingMode === MATERIAL_REUSE_TRACKING_MODE.SERIALIZED && !Number.isInteger(quantity)) {
            throw new BadRequestError('Vat tu theo doi tung chiec nen so luong phai la so nguyen');
        }
        const pool = await ReusableMaterialStock.findOneAndUpdate(
            { plantId, materialId: material._id, availableQuantity: { $gte: quantity } },
            { $inc: { availableQuantity: -quantity }, $set: { lastMovementAt: new Date() } },
            { returnDocument: 'after', session }
        );
        if (!pool) throw new BadRequestError('Kho tai su dung khong du so luong de cap');
        const { campaign, holder } = await resolveTargetContext(req.body, plantId, session);
        const issuedAt = new Date();
        const dueAt = calculateDueAt(req.body.dueAt, issuedAt, Number(material.defaultReturnDays || 0));
        if (dueAt && dueAt.getTime() < issuedAt.getTime()) {
            throw new BadRequestError('Han du kien tra khong duoc nam trong qua khu');
        }
        assignment = await createAssignmentWithMovement({
            assignmentData: {
                plantId,
                materialId: material._id,
                materialCode: material.code,
                materialName: material.name,
                unit: material.unit,
                trackingMode: material.reuseTrackingMode,
                ...holder,
                campaignId: campaign._id,
                productionItemId: campaign.productionItemId,
                itemCode: campaign.itemCode,
                itemName: campaign.itemName,
                orderCode: campaign.orderCode,
                sourceType: MATERIAL_CUSTODY_SOURCE_TYPE.REUSABLE_POOL,
                quantityIssued: quantity,
                unitPrice: 0,
                issuedAt,
                dueAt,
                note: req.body.note?.trim() || undefined,
            },
            performedBy: req.userId,
            session,
        });
        await session.commitTransaction();
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeAssignment(assignment),
            message: 'Da cap lai vat tu tu kho tai su dung, khong ghi them chi phi',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const transferAssignment = async (req: Request, res: Response, _next: NextFunction) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let targetAssignment: any;
    try {
        const source = await MaterialCustodyAssignment.findOne({
            _id: req.params.id,
            isDeleted: { $ne: true },
        }).session(session);
        if (!source) throw new NotFoundError('Khong tim thay dong vat tu dang su dung');
        assertPlantAccess(req, source.plantId);
        const quantity = Number(req.body.quantity);
        const outstanding = getOutstanding(source);
        if (quantity > outstanding + EPSILON)
            throw new BadRequestError(`So luong chuyen vuot so dang giu (${outstanding} ${source.unit})`);
        const { campaign, holder } = await resolveTargetContext(req.body, String(source.plantId), session);
        source.quantityTransferred += quantity;
        const sourceCampaign = await MaterialUsageCampaign.findById(source.campaignId).session(session);
        refreshAssignmentStatus(source, sourceCampaign?.status);
        source.updatedBy = req.userId as any;
        await source.save({ session });
        const issuedAt = new Date();
        const dueAt = parseDate(req.body.dueAt);
        if (dueAt && dueAt.getTime() < issuedAt.getTime()) {
            throw new BadRequestError('Han du kien tra khong duoc nam trong qua khu');
        }
        targetAssignment = await createAssignmentWithMovement({
            assignmentData: {
                plantId: source.plantId,
                materialId: source.materialId,
                materialCode: source.materialCode,
                materialName: source.materialName,
                unit: source.unit,
                trackingMode: source.trackingMode,
                ...holder,
                campaignId: campaign._id,
                productionItemId: campaign.productionItemId,
                itemCode: campaign.itemCode,
                itemName: campaign.itemName,
                orderCode: campaign.orderCode,
                sourceType: MATERIAL_CUSTODY_SOURCE_TYPE.CUSTODY_TRANSFER,
                sourceAssignmentId: source._id,
                quantityIssued: quantity,
                unitPrice: source.unitPrice,
                issuedAt,
                dueAt,
                note: req.body.note?.trim() || undefined,
            },
            performedBy: req.userId,
            session,
        });
        await MaterialCustodyMovement.create(
            [
                {
                    plantId: source.plantId,
                    assignmentId: source._id,
                    campaignId: source.campaignId,
                    materialId: source.materialId,
                    recipientId: source.recipientId,
                    type: MATERIAL_CUSTODY_MOVEMENT_TYPE.TRANSFER_OUT,
                    quantity,
                    note: `Chuyen sang ${holder.holderName} - ${campaign.itemCode}`,
                    performedBy: req.userId,
                    occurredAt: issuedAt,
                },
            ],
            { session }
        );
        await session.commitTransaction();
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeAssignment(targetAssignment),
            message: 'Da chuyen nguoi giu hoac ma hang, khong phat sinh them chi phi',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const listReusableStock = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const rows = await ReusableMaterialStock.find({ plantId })
        .populate('materialId', 'code name unit reuseTrackingMode conditionCheckRequired')
        .sort({ availableQuantity: -1 })
        .lean();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: rows.map((row: any) => ({
                id: toId(row),
                plantId: toId(row.plantId),
                materialId: toId(row.materialId),
                materialCode: row.materialId?.code,
                materialName: row.materialId?.name,
                unit: row.materialId?.unit,
                trackingMode: row.materialId?.reuseTrackingMode,
                availableQuantity: Number(row.availableQuantity || 0),
                repairQuantity: Number(row.repairQuantity || 0),
                damagedQuantity: Number(row.damagedQuantity || 0),
                lastMovementAt: toIso(row.lastMovementAt),
            })),
            message: 'Lay kho vat tu tai su dung thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getSummary = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const plantObjectId = new mongoose.Types.ObjectId(plantId);
    const now = new Date();
    const [assignmentStats, poolStats, campaignCounts, recipientCount] = await Promise.all([
        MaterialCustodyAssignment.aggregate([
            { $match: { plantId: plantObjectId, isDeleted: { $ne: true } } },
            { $addFields: { outstanding: outstandingExpression } },
            {
                $group: {
                    _id: null,
                    totalAssignments: { $sum: 1 },
                    openAssignments: { $sum: { $cond: [{ $gt: ['$outstanding', EPSILON] }, 1, 0] } },
                    overdueAssignments: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $gt: ['$outstanding', EPSILON] },
                                        { $ne: ['$dueAt', null] },
                                        { $lt: ['$dueAt', now] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                    outstandingQuantity: { $sum: '$outstanding' },
                    outstandingValue: { $sum: { $multiply: ['$outstanding', { $ifNull: ['$unitPrice', 0] }] } },
                    lostQuantity: { $sum: { $ifNull: ['$quantityLost', 0] } },
                    damagedQuantity: { $sum: { $ifNull: ['$quantityReturnedDamaged', 0] } },
                    holders: {
                        $addToSet: {
                            $cond: [
                                { $gt: ['$outstanding', EPSILON] },
                                { $ifNull: ['$recipientId', '$holderName'] },
                                null,
                            ],
                        },
                    },
                },
            },
        ]),
        ReusableMaterialStock.aggregate([
            { $match: { plantId: plantObjectId } },
            {
                $group: {
                    _id: null,
                    materialCount: { $sum: 1 },
                    availableQuantity: { $sum: '$availableQuantity' },
                    repairQuantity: { $sum: '$repairQuantity' },
                    damagedQuantity: { $sum: '$damagedQuantity' },
                },
            },
        ]),
        MaterialUsageCampaign.aggregate([
            { $match: { plantId: plantObjectId, isDeleted: { $ne: true } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        MaterialRecipient.countDocuments({ plantId, isDeleted: { $ne: true }, isActive: { $ne: false } }),
    ]);
    const assignments = assignmentStats[0] || {};
    const holders = (assignments.holders || []).filter(Boolean);
    const pool = poolStats[0] || {};
    const campaigns = Object.fromEntries(campaignCounts.map((row: any) => [row._id, row.count]));
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                totalAssignments: Number(assignments.totalAssignments || 0),
                openAssignments: Number(assignments.openAssignments || 0),
                overdueAssignments: Number(assignments.overdueAssignments || 0),
                outstandingQuantity: Number(assignments.outstandingQuantity || 0),
                outstandingValue: Number(assignments.outstandingValue || 0),
                activeHolderCount: holders.length,
                lostQuantity: Number(assignments.lostQuantity || 0),
                damagedQuantity: Number(assignments.damagedQuantity || 0),
                reusableMaterialCount: Number(pool.materialCount || 0),
                reusableAvailableQuantity: Number(pool.availableQuantity || 0),
                reusableRepairQuantity: Number(pool.repairQuantity || 0),
                reusableDamagedQuantity: Number(pool.damagedQuantity || 0),
                activeCampaigns: Number(campaigns.active || 0),
                recallingCampaigns: Number(campaigns.recalling || 0),
                activeRecipientCount: recipientCount,
            },
            message: 'Lay tong quan cap va thu hoi vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const exportMaterialCustodyReport = async (req: Request, res: Response, _next: NextFunction) => {
    const plantId = resolvePlantId(req, req.query.plantId);
    const plantObjectId = new mongoose.Types.ObjectId(plantId);
    const assignmentFilter: Record<string, any> = { plantId, isDeleted: { $ne: true } };
    if (req.query.status) assignmentFilter.status = String(req.query.status);
    if (req.query.campaignId) assignmentFilter.campaignId = String(req.query.campaignId);
    const regex = buildSearchRegex(req.query.search, { flexibleWhitespace: true });
    if (regex) {
        assignmentFilter.$or = [
            { materialCode: regex },
            { materialName: regex },
            { holderCode: regex },
            { holderName: regex },
            { department: regex },
            { lineName: regex },
            { itemCode: regex },
            { orderCode: regex },
        ];
    }

    const [plant, assignmentRows, campaignRows, poolRows, assignmentStats, campaignCounts] = await Promise.all([
        Plant.findById(plantId).select('name code').lean(),
        MaterialCustodyAssignment.find(assignmentFilter).sort({ status: 1, dueAt: 1, issuedAt: -1 }).lean(),
        MaterialUsageCampaign.find({ plantId, isDeleted: { $ne: true } })
            .sort({ startedAt: -1 })
            .lean(),
        ReusableMaterialStock.find({ plantId })
            .populate('materialId', 'code name unit')
            .sort({ availableQuantity: -1 })
            .lean(),
        MaterialCustodyAssignment.aggregate([
            { $match: { plantId: plantObjectId, isDeleted: { $ne: true } } },
            { $addFields: { outstanding: outstandingExpression } },
            {
                $group: {
                    _id: null,
                    openAssignments: { $sum: { $cond: [{ $gt: ['$outstanding', EPSILON] }, 1, 0] } },
                    overdueAssignments: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $gt: ['$outstanding', EPSILON] },
                                        { $ne: ['$dueAt', null] },
                                        { $lt: ['$dueAt', new Date()] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                    outstandingValue: { $sum: { $multiply: ['$outstanding', { $ifNull: ['$unitPrice', 0] }] } },
                    holders: {
                        $addToSet: {
                            $cond: [
                                { $gt: ['$outstanding', EPSILON] },
                                { $ifNull: ['$recipientId', '$holderName'] },
                                null,
                            ],
                        },
                    },
                },
            },
        ]),
        MaterialUsageCampaign.aggregate([
            { $match: { plantId: plantObjectId, isDeleted: { $ne: true } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
    ]);
    if (!plant) throw new NotFoundError('Khong tim thay co so');

    const campaignIds = campaignRows.map((campaign: any) => campaign._id);
    const campaignStats = campaignIds.length
        ? await MaterialCustodyAssignment.aggregate([
              { $match: { campaignId: { $in: campaignIds }, isDeleted: { $ne: true } } },
              {
                  $group: {
                      _id: '$campaignId',
                      assignmentCount: { $sum: 1 },
                      issuedQuantity: { $sum: '$quantityIssued' },
                      outstandingQuantity: { $sum: outstandingExpression },
                      holders: { $addToSet: { $ifNull: ['$recipientId', '$holderName'] } },
                  },
              },
              {
                  $project: {
                      assignmentCount: 1,
                      issuedQuantity: 1,
                      outstandingQuantity: 1,
                      holderCount: { $size: '$holders' },
                  },
              },
          ])
        : [];
    const statsByCampaign = new Map(campaignStats.map((row: any) => [String(row._id), row]));
    const assignments = assignmentRows.map(serializeAssignment);
    const campaigns = campaignRows.map((campaign: any) =>
        serializeCampaign(campaign, statsByCampaign.get(String(campaign._id)))
    );
    const reusableStock = poolRows.map((row: any) => ({
        materialCode: row.materialId?.code,
        materialName: row.materialId?.name,
        unit: row.materialId?.unit,
        availableQuantity: Number(row.availableQuantity || 0),
        repairQuantity: Number(row.repairQuantity || 0),
        damagedQuantity: Number(row.damagedQuantity || 0),
        lastMovementAt: row.lastMovementAt,
    }));
    const baseStats = assignmentStats[0] || {};
    const counts = Object.fromEntries(campaignCounts.map((row: any) => [row._id, row.count]));
    const workbook = buildMaterialCustodyWorkbook({
        plantName: `${(plant as any).name}${(plant as any).code ? ` (${(plant as any).code})` : ''}`,
        generatedAt: new Date(),
        assignments,
        campaigns,
        reusableStock,
        summary: {
            openAssignments: Number(baseStats.openAssignments || 0),
            overdueAssignments: Number(baseStats.overdueAssignments || 0),
            activeHolderCount: (baseStats.holders || []).filter(Boolean).length,
            outstandingValue: Number(baseStats.outstandingValue || 0),
            reusableAvailableQuantity: reusableStock.reduce((sum, row) => sum + row.availableQuantity, 0),
            reusableRepairQuantity: reusableStock.reduce((sum, row) => sum + row.repairQuantity, 0),
            reusableDamagedQuantity: reusableStock.reduce((sum, row) => sum + row.damagedQuantity, 0),
            activeCampaigns: Number(counts.active || 0),
            recallingCampaigns: Number(counts.recalling || 0),
        },
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bao-cao-ccdc-thu-hoi-${dateKey}.xlsx"`);
    return res.status(StatusCodes.OK).send(Buffer.from(buffer));
};
