import { CronJob } from 'cron';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionDay from '@/models/ProductionDay';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionReminderDispatch from '@/models/ProductionReminderDispatch';
import ProductionReminderEvent from '@/models/ProductionReminderEvent';
import ProductionReminderRule from '@/models/ProductionReminderRule';
import PushSubscription from '@/models/PushSubscription';
import User from '@/models/User';
import { notifyUserUpserted, type NotificationDeliverySummary } from './notification.helper';
import {
    PRODUCTION_TIME_ZONE,
    buildProductionPerformanceCopy,
    buildProductionReminderBucketKey,
    buildProductionReminderCopy,
    evaluateProductionReminderSlots,
    getProductionLocalDate,
    shouldNotifyProductionPerformance,
    type ProductionReminderSlotState,
} from './production-reminder.helpers';
import { sendSuccess } from './service.helpers';

type ReminderTrigger = 'schedule' | 'startup' | 'internal' | 'manual';

const DEFAULT_RULE = {
    enabled: true,
    graceMinutes: 2,
    repeatMinutes: 5,
    escalationMinutes: 15,
    escalateToManagers: true,
    telegramFallback: true,
    underTargetEnabled: true,
    underTargetThreshold: 80,
    additionalRecipientIds: [],
};
const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const DISPATCH_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
let scheduleStarted = false;
let evaluationRunning = false;

const toId = (value: any) => String(value?._id ?? value ?? '');
const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');
const canSwitchPlant = (req: Request) => [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE);

const assertPlantAccess = (req: Request, plantId: string) => {
    if (canSwitchPlant(req)) return;
    if (!plantId || plantId !== userPlantId(req)) {
        throw new UnAuthorizedError('Bạn chỉ được quản lý nhắc sản lượng của cơ sở được phân công');
    }
};

const resolvePlant = async (req: Request, input?: unknown) => {
    const plantId = String(input || userPlantId(req) || '');
    if (!mongoose.isValidObjectId(plantId)) throw new BadRequestError('Cơ sở không hợp lệ');
    assertPlantAccess(req, plantId);
    const plant: any = await Plant.findById(plantId).select('name code').lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: plantId, name: String(plant.name || ''), code: String(plant.code || '') };
};

const getOrCreateRule = async (plantId: string) => {
    try {
        return await ProductionReminderRule.findOneAndUpdate(
            { plantId },
            { $setOnInsert: { plantId, ...DEFAULT_RULE } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
        const existing = await ProductionReminderRule.findOne({ plantId });
        if (!existing) throw error;
        return existing;
    }
};

const serializeRule = (rule: any) => ({
    id: toId(rule),
    plantId: toId(rule.plantId),
    enabled: rule.enabled !== false,
    graceMinutes: Number(rule.graceMinutes ?? DEFAULT_RULE.graceMinutes),
    repeatMinutes: Number(rule.repeatMinutes ?? DEFAULT_RULE.repeatMinutes),
    escalationMinutes: Number(rule.escalationMinutes ?? DEFAULT_RULE.escalationMinutes),
    escalateToManagers: rule.escalateToManagers !== false,
    telegramFallback: rule.telegramFallback !== false,
    underTargetEnabled: rule.underTargetEnabled !== false,
    underTargetThreshold: Number(rule.underTargetThreshold ?? DEFAULT_RULE.underTargetThreshold),
    additionalRecipientIds: (rule.additionalRecipientIds || []).map(toId),
    updatedAt: rule.updatedAt?.toISOString?.() ?? rule.updatedAt,
});

const serializeEvent = (event: any) => ({
    id: toId(event),
    plantId: toId(event.plantId),
    dayId: toId(event.dayId),
    productionDate: event.productionDate,
    slotKey: event.slotKey,
    slotLabel: event.slotLabel,
    state: event.state,
    dueAt: event.dueAt?.toISOString?.() ?? event.dueAt,
    missingLineCodes: event.missingLineCodes || [],
    underTargetLineCodes: event.underTargetLineCodes || [],
    reminderCount: Number(event.reminderCount || 0),
    lastNotifiedAt: event.lastNotifiedAt?.toISOString?.() ?? event.lastNotifiedAt,
    nextNotifyAt: event.nextNotifyAt?.toISOString?.() ?? event.nextNotifyAt,
    escalatedAt: event.escalatedAt?.toISOString?.() ?? event.escalatedAt,
    performanceNotifiedAt: event.performanceNotifiedAt?.toISOString?.() ?? event.performanceNotifiedAt,
    resolvedAt: event.resolvedAt?.toISOString?.() ?? event.resolvedAt,
    lastDelivery: event.lastDelivery || {},
});

const getPrimaryRecipientIds = async (plantId: string, rule: any) => {
    const additionalIds = (rule.additionalRecipientIds || []).map(toId).filter(mongoose.isValidObjectId);
    const users = await User.find({
        plantId,
        isDeleted: { $ne: true },
        isActive: true,
        status: { $ne: false },
        $or: [{ role: USER_ROLE.LINE_LEADER }, ...(additionalIds.length ? [{ _id: { $in: additionalIds } }] : [])],
    }).select('_id');
    return [...new Set(users.map((user) => String(user._id)))];
};

const getEscalationRecipientIds = async (plantId: string) => {
    const users = await User.find({
        plantId,
        role: USER_ROLE.MANAGER,
        isDeleted: { $ne: true },
        isActive: true,
        status: { $ne: false },
    }).select('_id');
    return users.map((user) => String(user._id));
};

const emptyDelivery = (): NotificationDeliverySummary => ({
    inAppCreated: 0,
    webPushSent: 0,
    telegramSent: 0,
    failedChannels: 0,
});

const addDelivery = (target: NotificationDeliverySummary, source: NotificationDeliverySummary) => {
    target.inAppCreated += source.inAppCreated;
    target.webPushSent += source.webPushSent;
    target.telegramSent += source.telegramSent;
    target.failedChannels += source.failedChannels;
};

const sendMissingReminder = async ({
    day,
    plantId,
    rule,
    slots,
    primaryRecipientIds,
    escalationRecipientIds,
    newlyEscalated,
}: {
    day: any;
    plantId: string;
    rule: any;
    slots: ProductionReminderSlotState[];
    primaryRecipientIds: string[];
    escalationRecipientIds: string[];
    newlyEscalated: boolean;
}) => {
    const escalated = slots.some((slot) => slot.overdueMinutes >= Number(rule.escalationMinutes || 15));
    const copy = buildProductionReminderCopy(slots, escalated);
    const actionData = {
        plantId,
        productionDate: day.productionDate,
        slotKey: copy.oldestSlotKey,
        focus: 'missing',
    };
    const delivery = emptyDelivery();
    await Promise.all(
        primaryRecipientIds.map(async (userId) => {
            const result = await notifyUserUpserted(
                userId,
                {
                    type: escalated ? 'error' : 'warning',
                    actionType: 'production',
                    actionId: String(day._id),
                    actionData,
                    title: copy.title,
                    message: copy.message,
                },
                {
                    dedupeKey: `production-reminder:${plantId}:${day.productionDate}`,
                    deliveryTag: `production-reminder:${plantId}:${day.productionDate}`,
                    webPush: {
                        ttlSeconds: Number(rule.repeatMinutes || 5) * 60 + 60,
                        urgency: 'high',
                    },
                    telegramMode: rule.telegramFallback ? 'fallback' : 'off',
                }
            );
            addDelivery(delivery, result);
        })
    );

    if (newlyEscalated && rule.escalateToManagers !== false) {
        const primarySet = new Set(primaryRecipientIds);
        await Promise.all(
            escalationRecipientIds
                .filter((id) => !primarySet.has(id))
                .map(async (userId) => {
                    const result = await notifyUserUpserted(
                        userId,
                        {
                            type: 'error',
                            actionType: 'production',
                            actionId: String(day._id),
                            actionData,
                            title: `Cảnh báo quản lý: ${copy.missingLineCount} chuyền chậm nhập`,
                            message: copy.message,
                        },
                        {
                            dedupeKey: `production-escalation:${plantId}:${day.productionDate}`,
                            deliveryTag: `production-escalation:${plantId}:${day.productionDate}`,
                            webPush: { ttlSeconds: 15 * 60, urgency: 'high' },
                            telegramMode: rule.telegramFallback ? 'fallback' : 'off',
                        }
                    );
                    addDelivery(delivery, result);
                })
        );
    }

    const escalatedRecipients = newlyEscalated
        ? escalationRecipientIds.filter((id) => !new Set(primaryRecipientIds).has(id)).length
        : 0;
    return { delivery, attemptedRecipients: primaryRecipientIds.length + escalatedRecipients };
};

const sendPerformanceWarning = async (
    day: any,
    plantId: string,
    rule: any,
    slot: ProductionReminderSlotState,
    recipientIds: string[]
) => {
    const copy = buildProductionPerformanceCopy(slot, Number(rule.underTargetThreshold || 80));
    const delivery = emptyDelivery();
    await Promise.all(
        recipientIds.map(async (userId) => {
            const result = await notifyUserUpserted(
                userId,
                {
                    type: 'warning',
                    actionType: 'production',
                    actionId: String(day._id),
                    actionData: {
                        plantId,
                        productionDate: day.productionDate,
                        slotKey: slot.slotKey,
                        focus: 'under-target',
                    },
                    title: copy.title,
                    message: copy.message,
                },
                {
                    dedupeKey: `production-performance:${plantId}:${day.productionDate}:${slot.slotKey}`,
                    deliveryTag: `production-performance:${plantId}:${day.productionDate}:${slot.slotKey}`,
                    webPush: { ttlSeconds: 30 * 60, urgency: 'normal' },
                    telegramMode: rule.telegramFallback ? 'fallback' : 'off',
                }
            );
            addDelivery(delivery, result);
        })
    );
    return delivery;
};

const claimDispatch = async (plantId: string, now: Date, trigger: ReminderTrigger) => {
    // Khóa theo từng phút để grace=2 không bị trễ tới biên của bucket 5 phút.
    // Chu kỳ nhắc lại vẫn do nextNotifyAt của từng sự kiện kiểm soát.
    const bucketKey = buildProductionReminderBucketKey(now, 1);
    try {
        return await ProductionReminderDispatch.create({
            plantId,
            bucketKey,
            trigger,
            status: 'running',
            startedAt: now,
            expiresAt: new Date(now.getTime() + DISPATCH_RETENTION_MS),
        });
    } catch (error: any) {
        if (error?.code === 11000) return null;
        throw error;
    }
};

const evaluateProductionDay = async (day: any, rule: any, now: Date) => {
    const plantId = String(day.plantId);
    if (day.status !== 'draft' || rule.enabled === false) {
        const state = rule.enabled === false ? 'expired' : 'resolved';
        const reason = rule.enabled === false ? 'rule_disabled' : 'day_closed';
        const result = await ProductionReminderEvent.updateMany(
            { plantId, productionDate: day.productionDate, state: 'open' },
            { $set: { state, resolutionReason: reason, resolvedAt: now, nextNotifyAt: null } }
        );
        return { evaluatedSlots: 0, notified: 0, resolved: result.modifiedCount, performanceWarnings: 0 };
    }

    const records = await ProductionLineRecord.find({ dayId: day._id })
        .select('lineId lineCode workerCountConfirmedAt runs entries')
        .lean();
    const slots = evaluateProductionReminderSlots(day, records, now, rule.toObject?.() || rule);
    const existingEvents = await ProductionReminderEvent.find({
        plantId,
        productionDate: day.productionDate,
    });
    const eventBySlot = new Map(existingEvents.map((event: any) => [String(event.slotKey), event]));
    const dueKeys = new Set(slots.map((slot) => slot.slotKey));
    const eventsToNotify: any[] = [];
    const performanceToNotify: Array<{ event: any; slot: ProductionReminderSlotState }> = [];
    let resolved = 0;

    for (const slot of slots) {
        const existing: any = eventBySlot.get(slot.slotKey);
        const missingLineCodes = slot.missingLines.map((line) => line.lineCode);
        const missingLineIds = slot.missingLines.map((line) => line.lineId).filter(mongoose.isValidObjectId);
        const open = missingLineCodes.length > 0;
        const performanceDue = shouldNotifyProductionPerformance(
            slot,
            Number(rule.repeatMinutes || 5),
            Boolean(existing?.performanceNotifiedAt)
        );
        // Khung đã báo đủ và không có cảnh báo mới không cần ghi lại Mongo mỗi phút.
        if (!open && existing?.state !== 'open' && !performanceDue) continue;
        const nextNotifyAt = open
            ? existing?.lastNotifiedAt
                ? new Date(new Date(existing.lastNotifiedAt).getTime() + Number(rule.repeatMinutes || 5) * 60_000)
                : now
            : null;
        const event: any = await ProductionReminderEvent.findOneAndUpdate(
            { plantId, productionDate: day.productionDate, slotKey: slot.slotKey },
            {
                $set: {
                    dayId: day._id,
                    slotLabel: slot.slotLabel,
                    dueAt: slot.dueAt,
                    state: open ? 'open' : 'resolved',
                    missingLineIds,
                    missingLineCodes,
                    underTargetLineCodes: slot.underTargetLines.map((line) => line.lineCode),
                    lastDetectedAt: now,
                    nextNotifyAt,
                    ...(open && existing && existing.state !== 'open'
                        ? { escalatedAt: null, lastNotifiedAt: null, reminderCount: 0 }
                        : {}),
                    ...(open
                        ? { resolvedAt: null, resolutionReason: null }
                        : { resolvedAt: now, resolutionReason: 'reported' }),
                },
                $setOnInsert: {
                    plantId,
                    productionDate: day.productionDate,
                    slotKey: slot.slotKey,
                    firstDetectedAt: now,
                    expiresAt: new Date(now.getTime() + EVENT_RETENTION_MS),
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (
            open &&
            (existing?.state !== 'open' || !existing?.lastNotifiedAt || nextNotifyAt!.getTime() <= now.getTime())
        ) {
            eventsToNotify.push({ event, slot });
        }
        if (!open && existing?.state === 'open') resolved += 1;
        if (performanceDue) {
            performanceToNotify.push({ event, slot });
        }
    }

    const staleOpenEvents = existingEvents.filter(
        (event: any) => event.state === 'open' && !dueKeys.has(String(event.slotKey))
    );
    if (staleOpenEvents.length) {
        await ProductionReminderEvent.updateMany(
            { _id: { $in: staleOpenEvents.map((event: any) => event._id) } },
            { $set: { state: 'resolved', resolvedAt: now, resolutionReason: 'slot_inactive', nextNotifyAt: null } }
        );
        resolved += staleOpenEvents.length;
    }

    const primaryRecipientIds = await getPrimaryRecipientIds(plantId, rule);
    let notified = 0;
    if (eventsToNotify.length) {
        const allOpenSlots = slots.filter((slot) => slot.missingLines.length > 0);
        const newlyEscalatedEvents = eventsToNotify.filter(
            ({ event, slot }) => slot.overdueMinutes >= Number(rule.escalationMinutes || 15) && !event.escalatedAt
        );
        const escalationRecipientIds = newlyEscalatedEvents.length ? await getEscalationRecipientIds(plantId) : [];
        const result = await sendMissingReminder({
            day,
            plantId,
            rule,
            slots: allOpenSlots,
            primaryRecipientIds,
            escalationRecipientIds,
            newlyEscalated: newlyEscalatedEvents.length > 0,
        });
        const notifiedIds = eventsToNotify.map(({ event }) => event._id);
        await ProductionReminderEvent.updateMany(
            { _id: { $in: notifiedIds } },
            {
                $set: {
                    lastNotifiedAt: now,
                    nextNotifyAt: new Date(now.getTime() + Number(rule.repeatMinutes || 5) * 60_000),
                    lastDelivery: {
                        ...result.delivery,
                        attemptedRecipients: result.attemptedRecipients,
                        at: now,
                    },
                },
                $inc: { reminderCount: 1 },
            }
        );
        if (newlyEscalatedEvents.length) {
            await ProductionReminderEvent.updateMany(
                { _id: { $in: newlyEscalatedEvents.map(({ event }) => event._id) } },
                { $set: { escalatedAt: now } }
            );
        }
        notified = result.attemptedRecipients;
    }

    let performanceWarnings = 0;
    for (const { event, slot } of performanceToNotify) {
        const escalationRecipients = rule.escalateToManagers !== false ? await getEscalationRecipientIds(plantId) : [];
        const recipients = [...new Set([...primaryRecipientIds, ...escalationRecipients])];
        const delivery = await sendPerformanceWarning(day, plantId, rule, slot, recipients);
        await ProductionReminderEvent.updateOne(
            {
                _id: event._id,
                $or: [{ performanceNotifiedAt: { $exists: false } }, { performanceNotifiedAt: null }],
            },
            {
                $set: {
                    performanceNotifiedAt: now,
                    lastDelivery: { ...delivery, attemptedRecipients: recipients.length, at: now },
                },
            }
        );
        performanceWarnings += recipients.length;
    }

    return { evaluatedSlots: slots.length, notified, resolved, performanceWarnings };
};

export const evaluateProductionReminders = async (trigger: ReminderTrigger = 'schedule', now = new Date()) => {
    if (evaluationRunning) return { skipped: true, reason: 'already_running', plants: 0, results: [] };
    evaluationRunning = true;
    try {
        const productionDate = getProductionLocalDate(now);
        const days: any[] = await ProductionDay.find({ productionDate }).sort({ plantId: 1 }).lean();
        const results: any[] = [];
        for (const day of days) {
            const plantId = String(day.plantId);
            const rule: any = await getOrCreateRule(plantId);
            const dispatch = await claimDispatch(plantId, now, trigger);
            if (!dispatch) {
                results.push({ plantId, skipped: true, reason: 'bucket_claimed' });
                continue;
            }
            try {
                const summary = await evaluateProductionDay(day, rule, now);
                dispatch.status = 'completed';
                dispatch.completedAt = new Date();
                dispatch.summary = summary;
                await dispatch.save();
                results.push({ plantId, ...summary });
            } catch (error) {
                dispatch.status = 'failed';
                dispatch.completedAt = new Date();
                dispatch.errorMessage = String(error instanceof Error ? error.message : error).slice(0, 500);
                await dispatch.save();
                console.error(`[ProductionReminder] Failed plant ${plantId}:`, error);
                results.push({ plantId, error: dispatch.errorMessage });
            }
        }
        return { skipped: false, productionDate, plants: days.length, results };
    } finally {
        evaluationRunning = false;
    }
};

export const startProductionReminderSchedule = () => {
    if (scheduleStarted) return;
    scheduleStarted = true;
    const job = new CronJob(
        '0 * * * * *',
        () => {
            void evaluateProductionReminders('schedule').catch((error) =>
                console.error('[ProductionReminder] Scheduled evaluation failed:', error)
            );
        },
        null,
        false,
        PRODUCTION_TIME_ZONE
    );
    job.start();
    void evaluateProductionReminders('startup').catch((error) =>
        console.error('[ProductionReminder] Startup evaluation failed:', error)
    );
};

const deliveryReadiness = async (users: any[]) => {
    const ids = users.map((user) => user._id);
    const subscriptions = ids.length
        ? await PushSubscription.find({ userId: { $in: ids }, isActive: true })
              .select('userId')
              .lean()
        : [];
    const pushCounts = new Map<string, number>();
    subscriptions.forEach((subscription: any) => {
        const id = String(subscription.userId);
        pushCounts.set(id, (pushCounts.get(id) || 0) + 1);
    });
    return users.map((user) => ({
        id: String(user._id),
        fullname: user.fullname || user.username || user.email,
        username: user.username,
        role: user.role,
        pushDeviceCount: pushCounts.get(String(user._id)) || 0,
        telegramLinked: Boolean(user.telegramChatId && !user.telegramDisabledAt),
    }));
};

export const getProductionReminderStatus = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const productionDate = String(req.query.date || getProductionLocalDate());
    const parsedDate = new Date(`${productionDate}T00:00:00.000Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(productionDate) ||
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== productionDate
    ) {
        throw new BadRequestError('Ngày sản xuất không hợp lệ');
    }
    const [rule, events, pushDeviceCount, user] = await Promise.all([
        getOrCreateRule(plant.id),
        ProductionReminderEvent.find({ plantId: plant.id, productionDate }).sort({ dueAt: 1 }).lean(),
        PushSubscription.countDocuments({ userId: req.userId, isActive: true }),
        User.findById(req.userId).select('telegramChatId telegramDisabledAt').lean(),
    ]);
    return sendSuccess(
        res,
        {
            plant,
            productionDate,
            serverTime: new Date().toISOString(),
            rule: serializeRule(rule),
            channel: {
                pushDeviceCount,
                telegramLinked: Boolean(user?.telegramChatId && !user.telegramDisabledAt),
                ready: pushDeviceCount > 0 || Boolean(user?.telegramChatId && !user.telegramDisabledAt),
            },
            events: events.map(serializeEvent),
        },
        'Đã tải trạng thái nhắc sản lượng'
    );
};

export const getProductionReminderSettings = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const [rule, users] = await Promise.all([
        getOrCreateRule(plant.id),
        User.find({
            plantId: plant.id,
            role: { $in: [USER_ROLE.LINE_LEADER, USER_ROLE.STAFF, USER_ROLE.MANAGER] },
            isDeleted: { $ne: true },
            isActive: true,
            status: { $ne: false },
        })
            .select('fullname username email role telegramChatId telegramDisabledAt')
            .sort({ role: 1, fullname: 1 })
            .lean(),
    ]);
    return sendSuccess(
        res,
        { plant, rule: serializeRule(rule), recipients: await deliveryReadiness(users) },
        'Đã tải cấu hình nhắc sản lượng'
    );
};

export const updateProductionReminderSettings = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const recipientIds = (req.body.additionalRecipientIds || []).map(String);
    if (recipientIds.length) {
        const validCount = await User.countDocuments({
            _id: { $in: recipientIds },
            plantId: plant.id,
            isDeleted: { $ne: true },
            isActive: true,
            status: { $ne: false },
        });
        if (validCount !== new Set(recipientIds).size) {
            throw new BadRequestError('Có người nhận không thuộc cơ sở đã chọn');
        }
    }
    const rule = await ProductionReminderRule.findOneAndUpdate(
        { plantId: plant.id },
        {
            $set: {
                enabled: req.body.enabled,
                graceMinutes: req.body.graceMinutes,
                repeatMinutes: req.body.repeatMinutes,
                escalationMinutes: req.body.escalationMinutes,
                escalateToManagers: req.body.escalateToManagers,
                telegramFallback: req.body.telegramFallback,
                underTargetEnabled: req.body.underTargetEnabled,
                underTargetThreshold: req.body.underTargetThreshold,
                additionalRecipientIds: [...new Set(recipientIds)],
                updatedBy: req.userId,
            },
            $setOnInsert: { plantId: plant.id },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return sendSuccess(res, serializeRule(rule), 'Đã cập nhật cấu hình nhắc sản lượng');
};

export const sendProductionReminderTest = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body?.plantId);
    if (!req.userId) throw new UnAuthorizedError('Phiên đăng nhập không hợp lệ');
    const productionDate = getProductionLocalDate();
    const result = await notifyUserUpserted(
        String(req.userId),
        {
            type: 'warning',
            actionType: 'production',
            actionData: { plantId: plant.id, productionDate, focus: 'missing' },
            title: 'Thử nhắc nhập sản lượng',
            message: 'Thiết bị này đã sẵn sàng nhận nhắc theo khung giờ.',
        },
        {
            dedupeKey: `production-test:${req.userId}`,
            deliveryTag: `production-test:${req.userId}`,
            webPush: { ttlSeconds: 10 * 60, urgency: 'high' },
            telegramMode: 'fallback',
        }
    );
    return sendSuccess(res, result, 'Đã gửi thông báo nhắc thử nghiệm');
};
