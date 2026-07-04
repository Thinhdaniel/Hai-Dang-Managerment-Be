import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';
import Asset from '@/models/Asset';
import FloorZone from '@/models/FloorZone';
import Maintenance from '@/models/Maintenance';
import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import customResponse from '@/utils/response';

// Sơ đồ mặt bằng xưởng: khu vực (FloorZone) + vị trí máy (asset.floorPos), toạ độ % 0-100.
// Trạng thái máy trên sơ đồ cập nhật real-time qua sự kiện socket asset:updated sẵn có.

const EXCLUDED_STATUSES = [ASSET_STATUS.DISPOSED, ASSET_STATUS.RETURNED_TO_PARTNER];

const serializeZone = (zone: any) => ({
    id: String(zone._id),
    name: zone.name,
    x: zone.x,
    y: zone.y,
    w: zone.w,
    h: zone.h,
});

const requirePlantId = (value: unknown): string => {
    const plantId = String(value ?? '');
    if (!mongoose.isValidObjectId(plantId)) {
        throw new BadRequestError('Thieu hoac sai plantId');
    }
    return plantId;
};

export const getFloorMap = async (req: Request, res: Response) => {
    const plantId = requirePlantId(req.query.plantId);

    const [zones, machines] = await Promise.all([
        FloorZone.find({ plantId }).sort({ createdAt: 1 }).lean(),
        Asset.find({
            plantId,
            isDeleted: { $ne: true },
            status: { $nin: EXCLUDED_STATUSES },
        })
            .select('name machineCode type status floorPos')
            .sort({ machineCode: 1 })
            .lean(),
    ]);

    // Nhiệt sự cố: đếm số phiếu hỏng đột xuất (emergency) 6 tháng gần nhất theo máy
    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    const machineIds = machines.map((m) => m._id);
    const incidentRows: { _id: mongoose.Types.ObjectId; count: number }[] = machineIds.length
        ? await Maintenance.aggregate([
              {
                  $match: {
                      isDeleted: { $ne: true },
                      status: { $ne: 'cancelled' },
                      type: 'emergency',
                      startDate: { $gte: since },
                      assetIds: { $in: machineIds },
                  },
              },
              { $unwind: '$assetIds' },
              { $match: { assetIds: { $in: machineIds } } },
              { $group: { _id: '$assetIds', count: { $sum: 1 } } },
          ])
        : [];
    const incidentMap = new Map(incidentRows.map((row) => [String(row._id), row.count]));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                zones: zones.map(serializeZone),
                machines: machines.map((m) => ({
                    id: String(m._id),
                    name: m.name,
                    machineCode: m.machineCode,
                    type: m.type,
                    status: m.status,
                    incidents6m: incidentMap.get(String(m._id)) ?? 0,
                    floorPos:
                        m.floorPos && typeof m.floorPos.x === 'number' && typeof m.floorPos.y === 'number'
                            ? { x: m.floorPos.x, y: m.floorPos.y }
                            : null,
                })),
            },
            message: 'Lay so do xuong thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// Chi phí bảo trì theo phiếu — cùng công thức với report.service (cost ?? actualCost ?? tổng costItems)
const getMaintenanceCost = (item: any) => {
    const costItemsTotal = (item.externalRepair?.costItems ?? []).reduce(
        (sum: number, costItem: any) => sum + Number(costItem.amount ?? 0),
        0
    );
    return Number(item.cost ?? item.externalRepair?.actualCost ?? costItemsTotal ?? 0);
};

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Thống kê 1 máy cho panel chi tiết trên sơ đồ: chi phí sửa 12 tháng theo tháng + lần hỏng 6 tháng
export const getFloorMachineStats = async (req: Request, res: Response) => {
    const assetId = String(req.params.id);
    if (!mongoose.isValidObjectId(assetId)) throw new BadRequestError('Sai id may');

    const asset = await Asset.findOne({ _id: assetId, isDeleted: { $ne: true } })
        .select('_id lastMaintenanceDate')
        .lean();
    if (!asset) throw new NotFoundError('Khong tim thay may');

    const since12m = new Date();
    since12m.setMonth(since12m.getMonth() - 11);
    since12m.setDate(1);
    since12m.setHours(0, 0, 0, 0);
    const since6m = new Date();
    since6m.setMonth(since6m.getMonth() - 6);

    const tickets = await Maintenance.find({
        isDeleted: { $ne: true },
        status: { $ne: 'cancelled' },
        $or: [{ assetId: asset._id }, { assetIds: asset._id }],
        startDate: { $gte: since12m },
    })
        .select('type startDate cost externalRepair.actualCost externalRepair.costItems assetIds')
        .lean();

    // Khung 12 tháng liên tục (kể cả tháng 0đ) để sparkline không bị đứt trục thời gian
    const months: { ym: string; cost: number }[] = [];
    const cursor = new Date(since12m);
    for (let i = 0; i < 12; i++) {
        months.push({ ym: monthKey(cursor), cost: 0 });
        cursor.setMonth(cursor.getMonth() + 1);
    }
    const monthIndex = new Map(months.map((m, i) => [m.ym, i]));

    let incidents6m = 0;
    for (const ticket of tickets) {
        const started = new Date(ticket.startDate);
        // Phiếu nhiều máy: chia đều chi phí cho số máy trong phiếu
        const shareCount = Math.max(ticket.assetIds?.length ?? 1, 1);
        const idx = monthIndex.get(monthKey(started));
        if (idx !== undefined) months[idx].cost += getMaintenanceCost(ticket) / shareCount;
        if (ticket.type === 'emergency' && started >= since6m) incidents6m += 1;
    }
    months.forEach((m) => {
        m.cost = Math.round(m.cost);
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                months,
                total12m: months.reduce((sum, m) => sum + m.cost, 0),
                incidents6m,
                ticketCount12m: tickets.length,
                lastMaintenanceAt: asset.lastMaintenanceDate ?? null,
            },
            message: 'Lay thong ke may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const coord = z.number().min(0).max(100);

const saveZonesSchema = z.object({
    plantId: z.string(),
    zones: z
        .array(
            z.object({
                id: z.string().optional(),
                name: z.string().trim().min(1).max(60),
                x: coord,
                y: coord,
                w: z.number().min(1).max(100),
                h: z.number().min(1).max(100),
            })
        )
        .max(40),
});

// Lưu toàn bộ khu vực của một cơ sở (thay thế trọn bộ: khu không gửi lên = xoá).
export const saveFloorZones = async (req: Request, res: Response) => {
    const parsed = saveZonesSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Du lieu khu vuc khong hop le');
    const plantId = requirePlantId(parsed.data.plantId);

    const keepIds = parsed.data.zones
        .map((zone) => zone.id)
        .filter((id): id is string => Boolean(id && mongoose.isValidObjectId(id)));

    await FloorZone.deleteMany({ plantId, _id: { $nin: keepIds } });

    const saved = [];
    for (const zone of parsed.data.zones) {
        const payload = { name: zone.name, x: zone.x, y: zone.y, w: zone.w, h: zone.h, updatedBy: req.userId };
        if (zone.id && mongoose.isValidObjectId(zone.id)) {
            const updated = await FloorZone.findOneAndUpdate(
                { _id: zone.id, plantId },
                { $set: payload },
                { new: true }
            ).lean();
            if (updated) saved.push(updated);
        } else {
            const created = await FloorZone.create({ ...payload, plantId });
            saved.push(created.toObject());
        }
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { zones: saved.map(serializeZone) },
            message: 'Luu khu vuc thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const savePositionsSchema = z.object({
    items: z
        .array(
            z.object({
                assetId: z.string(),
                // x/y = null nghĩa là gỡ máy khỏi sơ đồ
                x: coord.nullable(),
                y: coord.nullable(),
            })
        )
        .min(1)
        .max(500),
});

// Lưu vị trí hàng loạt máy trên sơ đồ (kéo-thả xong bấm Lưu một lần).
export const saveFloorPositions = async (req: Request, res: Response) => {
    const parsed = savePositionsSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Du lieu vi tri khong hop le');

    const updatedBy = req.userId && mongoose.isValidObjectId(req.userId)
        ? new mongoose.Types.ObjectId(String(req.userId))
        : undefined;

    const ops = parsed.data.items
        .filter((item) => mongoose.isValidObjectId(item.assetId))
        .map((item) => ({
            updateOne: {
                filter: { _id: new mongoose.Types.ObjectId(item.assetId), isDeleted: { $ne: true } },
                update:
                    item.x === null || item.y === null
                        ? { $unset: { floorPos: 1 }, $set: { updatedBy } }
                        : { $set: { floorPos: { x: item.x, y: item.y }, updatedBy } },
            },
        }));

    if (!ops.length) throw new BadRequestError('Khong co may hop le de cap nhat');

    const result = await Asset.bulkWrite(ops);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { updated: result.modifiedCount },
            message: 'Luu vi tri may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
