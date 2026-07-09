import { randomInt } from 'crypto';
import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import LuckyWheelEvent from '@/models/LuckyWheelEvent';
import User from '@/models/User';
import customResponse from '@/utils/response';

const participantSchema = z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().max(80).optional().nullable(),
    department: z.string().trim().max(160).optional().nullable(),
    plantName: z.string().trim().max(160).optional().nullable(),
    userId: z.string().optional().nullable(),
    weight: z.coerce.number().int().min(1).max(100).optional(),
    active: z.boolean().optional(),
});

const settingsSchema = z.object({
    removeWinnerAfterSpin: z.boolean().optional(),
    allowRepeatWinners: z.boolean().optional(),
    spinDurationMs: z.coerce.number().int().min(3500).max(15000).optional(),
    theme: z.enum(['haidang-night', 'gold-night', 'tet', 'ocean']).optional(),
    soundEnabled: z.boolean().optional(),
    confettiEnabled: z.boolean().optional(),
});

const eventSchema = z.object({
    name: z.string().trim().min(1).max(180),
    description: z.string().trim().max(1000).optional().nullable(),
    participants: z.array(participantSchema).max(500).default([]),
    settings: settingsSchema.optional(),
});

const updateEventSchema = eventSchema.partial();

const normalizeParticipant = (participant: z.infer<typeof participantSchema>) => ({
    ...(participant.id && mongoose.isValidObjectId(participant.id) ? { _id: participant.id } : {}),
    name: participant.name,
    code: participant.code || undefined,
    department: participant.department || undefined,
    plantName: participant.plantName || undefined,
    userId: participant.userId && mongoose.isValidObjectId(participant.userId) ? participant.userId : undefined,
    weight: participant.weight ?? 1,
    active: participant.active ?? true,
});

const actorName = async (req: Request) => {
    if (!req.userId || !mongoose.isValidObjectId(req.userId)) return undefined;
    const user = await User.findById(req.userId).select('name fullName email').lean();
    return (user as any)?.name || (user as any)?.fullName || user?.email;
};

const getEventOrThrow = async (id: string) => {
    if (!mongoose.isValidObjectId(id)) throw new BadRequestError('Sự kiện vòng quay không hợp lệ');
    const event = await LuckyWheelEvent.findOne({ _id: id, isDeleted: { $ne: true } });
    if (!event) throw new NotFoundError('Không tìm thấy sự kiện vòng quay');
    return event;
};

const getParamId = (req: Request) => String(req.params.id || '');

const buildEligiblePool = (event: any) => {
    const winnerIds = new Set((event.winners || []).map((winner: any) => String(winner.participantId || '')).filter(Boolean));
    return (event.participants || []).filter((participant: any) => {
        if (!participant.active) return false;
        if (!event.settings?.allowRepeatWinners && winnerIds.has(String(participant._id))) return false;
        return Boolean(participant.name);
    });
};

export const listLuckyWheelEvents = async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit || 20), 50);
    const events = await LuckyWheelEvent.find({ isDeleted: { $ne: true } })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

    res.status(StatusCodes.OK).json(
        customResponse({
            success: true,
            status: StatusCodes.OK,
            message: 'Danh sách sự kiện vòng quay',
            data: events,
        })
    );
};

export const getLuckyWheelEvent = async (req: Request, res: Response) => {
    const event = await getEventOrThrow(getParamId(req));
    res.status(StatusCodes.OK).json(
        customResponse({
            success: true,
            status: StatusCodes.OK,
            message: 'Chi tiết sự kiện vòng quay',
            data: event,
        })
    );
};

export const createLuckyWheelEvent = async (req: Request, res: Response) => {
    const payload = eventSchema.parse(req.body);
    const name = await actorName(req);
    const event = await LuckyWheelEvent.create({
        name: payload.name,
        description: payload.description || undefined,
        participants: payload.participants.map(normalizeParticipant),
        settings: payload.settings || {},
        createdBy: req.userId,
        createdByName: name,
        updatedBy: req.userId,
    });

    res.status(StatusCodes.CREATED).json(
        customResponse({
            success: true,
            status: StatusCodes.CREATED,
            message: 'Đã tạo sự kiện vòng quay',
            data: event,
        })
    );
};

export const updateLuckyWheelEvent = async (req: Request, res: Response) => {
    const event = await getEventOrThrow(getParamId(req));
    const payload = updateEventSchema.parse(req.body);

    if (payload.name !== undefined) event.name = payload.name;
    if (payload.description !== undefined) event.description = payload.description || undefined;
    if (payload.participants !== undefined) {
        event.participants = payload.participants.map(normalizeParticipant) as any;
    }
    if (payload.settings !== undefined) {
        const currentSettings = ((event.settings as any)?.toObject?.() || event.settings || {}) as Record<string, unknown>;
        event.settings = { ...currentSettings, ...payload.settings } as any;
    }
    event.updatedBy = req.userId as any;
    await event.save();

    res.status(StatusCodes.OK).json(
        customResponse({
            success: true,
            status: StatusCodes.OK,
            message: 'Đã cập nhật sự kiện vòng quay',
            data: event,
        })
    );
};

export const spinLuckyWheelEvent = async (req: Request, res: Response) => {
    const event = await getEventOrThrow(getParamId(req));
    if (event.status === 'archived') throw new BadRequestError('Sự kiện đã lưu trữ, không thể quay');

    const pool = buildEligiblePool(event);
    if (!pool.length) throw new BadRequestError('Không còn người tham gia hợp lệ để quay');

    const randomIndex = randomInt(pool.length);
    const winner = pool[randomIndex];
    const name = await actorName(req);
    const spinNo = (event.winners?.length || 0) + 1;

    const winnerRecord = {
        participantId: winner._id,
        name: winner.name,
        code: winner.code,
        department: winner.department,
        plantName: winner.plantName,
        spinNo,
        poolSize: pool.length,
        randomIndex,
        spunBy: req.userId,
        spunByName: name,
        spunAt: new Date(),
    };

    event.winners.push(winnerRecord as any);
    if (event.settings?.removeWinnerAfterSpin && !event.settings?.allowRepeatWinners) {
        const participant = event.participants.id(winner._id);
        if (participant) participant.active = false;
    }
    event.status = 'active';
    event.updatedBy = req.userId as any;
    await event.save();

    res.status(StatusCodes.OK).json(
        customResponse({
            success: true,
            status: StatusCodes.OK,
            message: 'Đã quay ra người may mắn',
            data: {
                event,
                winner: winnerRecord,
                winnerIndex: event.participants.findIndex((participant: any) => String(participant._id) === String(winner._id)),
                eligibleCount: pool.length,
            },
        })
    );
};

export const resetLuckyWheelWinners = async (req: Request, res: Response) => {
    const event = await getEventOrThrow(getParamId(req));
    event.winners = [] as any;
    event.participants.forEach((participant: any) => {
        participant.active = true;
    });
    event.updatedBy = req.userId as any;
    await event.save();

    res.status(StatusCodes.OK).json(
        customResponse({
            success: true,
            status: StatusCodes.OK,
            message: 'Đã đặt lại kết quả vòng quay',
            data: event,
        })
    );
};

export const deleteLuckyWheelEvent = async (req: Request, res: Response) => {
    const event = await getEventOrThrow(getParamId(req));
    event.isDeleted = true;
    event.deletedAt = new Date();
    event.updatedBy = req.userId as any;
    await event.save();

    res.status(StatusCodes.OK).json(
        customResponse({
            success: true,
            status: StatusCodes.OK,
            message: 'Đã xóa sự kiện vòng quay',
            data: { id: getParamId(req) },
        })
    );
};
