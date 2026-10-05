import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import WorkerNotebook from '@/models/WorkerNotebook';
import { notebookAttendance, notebookMonthSummary } from '@/services/worker-notebook.service';
import asyncHandler from '@/utils/asyncHandler';
import customResponse from '@/utils/response';
import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';

const router = Router();
router.use(authenticate, authorize(USER_ROLE.WORKER));

const entrySchema = z.object({
    itemCode: z.string().trim().min(1).max(100),
    operation: z.string().trim().min(1).max(120),
    quantity: z.number().positive().max(10000000),
    unit: z.string().trim().min(1).max(30).default('SP'),
    note: z.string().trim().max(300).default(''),
});

const todayInVietnam = () =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());

const parseDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new BadRequestError('Ngay khong hop le');
    }
    if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value || value > todayInVietnam()) {
        throw new BadRequestError('Khong the ghi cho ngay trong tuong lai');
    }
    return value;
};

const respond = (res: any, data: unknown, status = StatusCodes.OK) =>
    res.status(status).json(customResponse({ data, status, success: true, message: 'Thanh cong' }));

router.get(
    '/month',
    asyncHandler(async (req, res) => {
        const month = String(req.query.month ?? todayInVietnam().slice(0, 7));
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestError('Thang khong hop le');
        const days = await WorkerNotebook.find({
            userId: req.userId,
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
        })
            .sort({ date: 1 })
            .lean();
        const recent = await WorkerNotebook.find({ userId: req.userId, 'entries.0': { $exists: true } })
            .sort({ date: -1 })
            .limit(45)
            .lean();
        const suggestions = Array.from(
            new Map(
                recent.flatMap((day) =>
                    day.entries.map((entry) => [
                        JSON.stringify([entry.itemCode, entry.operation, entry.unit]),
                        {
                            itemCode: entry.itemCode,
                            operation: entry.operation,
                            unit: entry.unit,
                        },
                    ])
                )
            ).values()
        ).slice(0, 30);
        return respond(res, {
            month,
            ...notebookMonthSummary(days),
            suggestions,
        });
    })
);

router.get(
    '/day/:date',
    asyncHandler(async (req, res) => {
        const date = parseDate(String(req.params.date));
        const day = await WorkerNotebook.findOne({ userId: req.userId, date }).lean();
        const record = day ?? { date, attended: false, entries: [] };
        return respond(res, { ...record, ...notebookAttendance(record) });
    })
);

router.put(
    '/day/:date/attendance',
    asyncHandler(async (req, res) => {
        const date = parseDate(String(req.params.date));
        const parsed = z
            .union([
                z.object({
                    attendanceType: z.enum(['full', 'half', 'off']),
                    overtimeHours: z.number().min(0).max(24).multipleOf(0.01),
                }),
                z.object({ attended: z.boolean() }).strict(),
            ])
            .safeParse(req.body);
        if (!parsed.success) throw new BadRequestError('Trang thai diem danh khong hop le');
        const current = await WorkerNotebook.findOne({ userId: req.userId, date }).lean();
        const previous = notebookAttendance(current ?? {});
        const attendanceType =
            'attendanceType' in parsed.data
                ? parsed.data.attendanceType
                : parsed.data.attended
                  ? previous.attended
                      ? previous.attendanceType
                      : 'full'
                  : 'off';
        const overtimeHours = 'overtimeHours' in parsed.data ? parsed.data.overtimeHours : previous.overtimeHours;
        const day = await WorkerNotebook.findOneAndUpdate(
            { userId: req.userId, date },
            {
                $set: {
                    attendanceType,
                    overtimeHours,
                    attended: attendanceType !== 'off',
                    attendedAt: attendanceType !== 'off' ? (current?.attendedAt ?? new Date()) : null,
                },
                $setOnInsert: { userId: req.userId, date },
            },
            { upsert: true, returnDocument: 'after', runValidators: true }
        );
        return respond(res, day);
    })
);

router.post(
    '/day/:date/entries',
    asyncHandler(async (req, res) => {
        const date = parseDate(String(req.params.date));
        const parsed = entrySchema.safeParse(req.body);
        if (!parsed.success) throw new BadRequestError('Thong tin cong doan khong hop le');
        await WorkerNotebook.findOneAndUpdate(
            { userId: req.userId, date },
            { $setOnInsert: { userId: req.userId, date } },
            { upsert: true, returnDocument: 'after' }
        );
        const day = await WorkerNotebook.findOneAndUpdate(
            { userId: req.userId, date, 'entries.99': { $exists: false } },
            { $push: { entries: parsed.data } },
            { returnDocument: 'after', runValidators: true }
        );
        if (day) return respond(res, day, StatusCodes.CREATED);
        throw new BadRequestError('Moi ngay chi ghi toi da 100 cong doan');
    })
);

router.patch(
    '/day/:date/entries/:entryId',
    asyncHandler(async (req, res) => {
        const date = parseDate(String(req.params.date));
        const entryId = String(req.params.entryId);
        if (!mongoose.isValidObjectId(entryId)) throw new BadRequestError('Ma dong khong hop le');
        const parsed = entrySchema.safeParse(req.body);
        if (!parsed.success) throw new BadRequestError('Thong tin cong doan khong hop le');
        const fields = Object.fromEntries(
            Object.entries(parsed.data).map(([key, value]) => [`entries.$.${key}`, value])
        );
        const day = await WorkerNotebook.findOneAndUpdate(
            { userId: req.userId, date, 'entries._id': entryId },
            { $set: fields },
            { returnDocument: 'after', runValidators: true }
        );
        if (!day) throw new NotFoundError('Khong tim thay dong cong doan');
        return respond(res, day);
    })
);

router.delete(
    '/day/:date/entries/:entryId',
    asyncHandler(async (req, res) => {
        const date = parseDate(String(req.params.date));
        const entryId = String(req.params.entryId);
        if (!mongoose.isValidObjectId(entryId)) throw new BadRequestError('Ma dong khong hop le');
        const day = await WorkerNotebook.findOneAndUpdate(
            { userId: req.userId, date, 'entries._id': entryId },
            { $pull: { entries: { _id: entryId } } },
            { returnDocument: 'after' }
        );
        if (!day) throw new NotFoundError('Khong tim thay dong cong doan');
        return respond(res, day);
    })
);

export default router;
