import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';
import Asset from '@/models/Asset';
import FloorZone from '@/models/FloorZone';
import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError } from '@/errors/customError';
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
