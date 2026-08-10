import { BadRequestError, DuplicateError, NotFoundError } from '@/errors/customError';
import ProductionItem from '@/models/ProductionItem';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionQcRecord from '@/models/ProductionQcRecord';
import type { Request, Response } from 'express';
import { sendSuccess } from './service.helpers';
import { decideProductionEntrySync } from './production.helpers';
import { emitProductionChange, loadDayDetail, loadDayForQcWrite } from './production.service';

const normalizeOrderCode = (value: unknown) =>
    String(value || '')
        .trim()
        .toUpperCase();

const prepareInspections = async (plantId: string, productionDate: string, inputs: any[]) => {
    const itemIds = [...new Set(inputs.map((entry) => String(entry.itemId)))];
    const items: any[] = await ProductionItem.find({
        _id: { $in: itemIds },
        plantId,
    }).lean();
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    if (items.length !== itemIds.length) throw new BadRequestError('Có mã hàng không thuộc cơ sở đã chọn');

    return inputs.map((entry) => {
        const item: any = itemById.get(String(entry.itemId));
        const passedQuantity = Number(entry.passedQuantity || 0);
        const defectQuantity = Number(entry.defectQuantity || 0);
        if (entry.sourceType === 'carryover' && String(entry.sourceProductionDate) >= productionDate) {
            throw new BadRequestError('Ngày nguồn của hàng tồn phải trước ngày QC đang nhập');
        }
        return {
            ...(entry.id ? { _id: entry.id } : {}),
            itemId: item._id,
            itemCode: item.code,
            itemName: item.name,
            unit: item.unit || 'SP',
            orderCode: normalizeOrderCode(entry.orderCode) || undefined,
            inspectionType: entry.inspectionType || 'first_pass',
            sourceType: entry.sourceType || 'current_day',
            sourceProductionDate:
                entry.sourceType === 'carryover' && entry.sourceProductionDate ? entry.sourceProductionDate : undefined,
            passedQuantity,
            defectQuantity,
            totalQuantity: passedQuantity + defectQuantity,
            note: String(entry.note || '').trim() || undefined,
        };
    });
};

const lineResponse = async (day: any, role: string | undefined, lineId: string) => {
    const detail: any = await loadDayDetail(day, role);
    return detail.lines.find((line: any) => line.lineId === lineId);
};

export const upsertProductionQcRecord = async (req: Request, res: Response) => {
    const day = await loadDayForQcWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const slotKey = String(req.params.slotKey);
    if (!day.timeSlots.some((slot: any) => String(slot.key) === slotKey && slot.isActive !== false)) {
        throw new BadRequestError('Khung giờ không hợp lệ hoặc đã tắt');
    }
    const line: any = await ProductionLineRecord.findOne({ dayId: day._id, lineId })
        .select('lineId lineCode lineName')
        .lean();
    if (!line) throw new NotFoundError('Chuyền không thuộc ngày sản xuất này');

    const inspections = await prepareInspections(
        String(day.plantId),
        String(day.productionDate),
        req.body.inspections || []
    );
    const existing: any = await ProductionQcRecord.findOne({ dayId: day._id, lineId, slotKey });
    const syncDecision = decideProductionEntrySync(existing, {
        clientMutationId: req.body.clientMutationId,
        expectedUpdatedAt: req.body.expectedUpdatedAt,
        hasExpectedUpdatedAt: Object.prototype.hasOwnProperty.call(req.body, 'expectedUpdatedAt'),
    });
    if (syncDecision.action === 'conflict') {
        throw new DuplicateError(
            'Kết quả QC vừa được cập nhật từ thiết bị khác. Vui lòng tải dữ liệu mới nhất trước khi lưu lại.'
        );
    }
    if (syncDecision.action === 'idempotent') {
        return sendSuccess(res, await lineResponse(day, req.role, lineId), 'Kết quả QC đã được đồng bộ trước đó');
    }

    try {
        if (existing) {
            existing.inspections = inspections;
            existing.updatedBy = req.userId;
            existing.lastClientMutationId = req.body.clientMutationId;
            await existing.save();
        } else {
            await ProductionQcRecord.create({
                dayId: day._id,
                plantId: day.plantId,
                productionDate: day.productionDate,
                lineId: line.lineId,
                lineCode: line.lineCode,
                lineName: line.lineName,
                slotKey,
                inspections,
                enteredBy: req.userId,
                enteredAt: new Date(),
                updatedBy: req.userId,
                lastClientMutationId: req.body.clientMutationId,
            });
        }
    } catch (error: any) {
        if (error?.code === 11000) {
            throw new DuplicateError('Khung giờ QC vừa được tạo từ thiết bị khác, vui lòng tải lại');
        }
        if (error?.name === 'VersionError') {
            throw new DuplicateError('Kết quả QC vừa được cập nhật từ thiết bị khác, vui lòng tải lại');
        }
        throw error;
    }

    emitProductionChange(day, {
        changeType: 'qc-record-updated',
        lineId,
        slotKey,
        actorId: req.userId,
        clientMutationId: req.body.clientMutationId,
    });
    return sendSuccess(res, await lineResponse(day, req.role, lineId), 'Đã lưu kết quả QC theo mã hàng');
};

export const deleteProductionQcRecord = async (req: Request, res: Response) => {
    const day = await loadDayForQcWrite(req, String(req.params.dayId));
    const lineId = String(req.params.lineId);
    const slotKey = String(req.params.slotKey);
    const deleted = await ProductionQcRecord.findOneAndDelete({ dayId: day._id, lineId, slotKey });
    if (!deleted) throw new NotFoundError('Không tìm thấy kết quả QC theo mã hàng');
    emitProductionChange(day, {
        changeType: 'qc-record-deleted',
        lineId,
        slotKey,
        actorId: req.userId,
    });
    return sendSuccess(res, await lineResponse(day, req.role, lineId), 'Đã xóa kết quả QC trong khung giờ');
};
