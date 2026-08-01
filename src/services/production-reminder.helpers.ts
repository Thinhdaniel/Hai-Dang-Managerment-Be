import { createHash } from 'node:crypto';
import { resolveRunForSlot } from './production.helpers';

export const PRODUCTION_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const VIETNAM_OFFSET = '+07:00';
const MINUTE_MS = 60_000;

export type ProductionReminderRuleInput = {
    graceMinutes?: number;
    repeatMinutes?: number;
    escalationMinutes?: number;
    underTargetEnabled?: boolean;
    underTargetThreshold?: number;
};

export type ProductionReminderLineState = {
    lineId: string;
    lineCode: string;
    actual: number;
    target: number;
    achievementPercent: number;
};

export type ProductionReminderSlotState = {
    slotKey: string;
    slotLabel: string;
    dueAt: Date;
    overdueMinutes: number;
    dueLineCount: number;
    reportedLineCount: number;
    missingLines: ProductionReminderLineState[];
    underTargetLines: ProductionReminderLineState[];
};

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const toId = (value: unknown) => String((value as any)?._id ?? value ?? '');

export const getProductionLocalDate = (date = new Date()) =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: PRODUCTION_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);

export const productionMinuteToDate = (productionDate: string, minute: number) => {
    const localMidnight = Date.parse(`${productionDate}T00:00:00${VIETNAM_OFFSET}`);
    return new Date(localMidnight + Number(minute || 0) * MINUTE_MS);
};

export const buildProductionReminderBucketKey = (date: Date, repeatMinutes: number) => {
    const sizeMs = Math.max(1, repeatMinutes) * MINUTE_MS;
    return `${getProductionLocalDate(date)}:${Math.floor(date.getTime() / sizeMs)}`;
};

export const buildProductionReminderMissingHash = (slots: ProductionReminderSlotState[]) =>
    createHash('sha256')
        .update(
            slots
                .flatMap((slot) => slot.missingLines.map((line) => `${slot.slotKey}:${line.lineId}:${line.lineCode}`))
                .sort()
                .join('|')
        )
        .digest('hex')
        .slice(0, 24);

export const evaluateProductionReminderSlots = (
    dayInput: any,
    recordInputs: any[],
    now = new Date(),
    rule: ProductionReminderRuleInput = {}
): ProductionReminderSlotState[] => {
    const day = typeof dayInput?.toObject === 'function' ? dayInput.toObject() : dayInput;
    if (!day || day.status !== 'draft') return [];
    if (String(day.productionDate) !== getProductionLocalDate(now)) return [];

    const graceMinutes = Math.max(0, Number(rule.graceMinutes ?? 2));
    const threshold = Math.min(100, Math.max(10, Number(rule.underTargetThreshold ?? 80)));
    const slots = [...(day.timeSlots || [])].sort(
        (left: any, right: any) => Number(left.startMinute || 0) - Number(right.startMinute || 0)
    );

    return slots
        .filter((slot: any) => slot.isActive !== false)
        .map((slot: any) => {
            const dueAt = new Date(
                productionMinuteToDate(String(day.productionDate), Number(slot.endMinute)).getTime() +
                    graceMinutes * MINUTE_MS
            );
            if (dueAt.getTime() > now.getTime()) return undefined;

            const dueLines: Array<ProductionReminderLineState & { reported: boolean }> = [];
            recordInputs.forEach((input) => {
                const record = typeof input?.toObject === 'function' ? input.toObject() : input;
                if (!record?.workerCountConfirmedAt || !(record.runs || []).length) return;
                const run: any = resolveRunForSlot(record.runs || [], String(slot.key), slots);
                if (!run) return;
                const entries = (record.entries || []).filter(
                    (entry: any) => String(entry.slotKey) === String(slot.key)
                );
                const actual = entries.reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
                const durationHours = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)) / 60;
                const target = slot.kind === 'overtime' ? 0 : Number(run.hourlyQuota || 0) * durationHours;
                dueLines.push({
                    lineId: toId(record.lineId),
                    lineCode: String(record.lineCode || 'N/A'),
                    actual,
                    target: round(target, 1),
                    achievementPercent: target > 0 ? round((actual / target) * 100, 1) : 0,
                    reported: entries.length > 0,
                });
            });

            const missingLines = dueLines
                .filter((line) => !line.reported)
                .map(({ reported: _reported, ...line }) => line);
            const underTargetLines =
                rule.underTargetEnabled === false || missingLines.length > 0
                    ? []
                    : dueLines
                          .filter((line) => line.reported && line.target > 0 && line.achievementPercent < threshold)
                          .map(({ reported: _reported, ...line }) => line);

            return {
                slotKey: String(slot.key),
                slotLabel: String(slot.label || slot.key),
                dueAt,
                overdueMinutes: Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / MINUTE_MS)),
                dueLineCount: dueLines.length,
                reportedLineCount: dueLines.length - missingLines.length,
                missingLines,
                underTargetLines,
            } satisfies ProductionReminderSlotState;
        })
        .filter((slot): slot is ProductionReminderSlotState => Boolean(slot));
};

export const buildProductionReminderCopy = (slots: ProductionReminderSlotState[], escalated: boolean) => {
    const missing = slots.flatMap((slot) => slot.missingLines);
    const uniqueLineCodes = [...new Set(missing.map((line) => line.lineCode))];
    const oldest = [...slots].sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0];
    const slotCopy =
        slots.length === 1
            ? `khung ${oldest?.slotLabel || slots[0].slotKey}`
            : `${slots.length} khung giờ, cũ nhất ${oldest?.slotLabel || ''}`;
    const preview = uniqueLineCodes.slice(0, 5).join(', ');
    const remaining = Math.max(0, uniqueLineCodes.length - 5);
    return {
        title: escalated
            ? `Quá hạn nhập sản lượng: ${uniqueLineCodes.length} chuyền`
            : `Nhắc nhập sản lượng: ${uniqueLineCodes.length} chuyền`,
        message: `${slotCopy} còn thiếu ${preview}${remaining ? ` và ${remaining} chuyền khác` : ''}. Nhấn để nhập ngay.`,
        oldestSlotKey: oldest?.slotKey,
        missingLineCount: uniqueLineCodes.length,
    };
};

export const buildProductionPerformanceCopy = (slot: ProductionReminderSlotState, threshold: number) => {
    const preview = slot.underTargetLines
        .slice(0, 4)
        .map((line) => `${line.lineCode} ${line.achievementPercent}%`)
        .join(', ');
    const remaining = Math.max(0, slot.underTargetLines.length - 4);
    return {
        title: `${slot.underTargetLines.length} chuyền dưới ${threshold}% khoán giờ`,
        message: `Khung ${slot.slotLabel}: ${preview}${remaining ? ` và ${remaining} chuyền khác` : ''}.`,
    };
};

export const shouldNotifyProductionPerformance = (
    slot: ProductionReminderSlotState,
    repeatMinutes: number,
    alreadyNotified: boolean
) =>
    !alreadyNotified &&
    slot.missingLines.length === 0 &&
    slot.underTargetLines.length > 0 &&
    slot.overdueMinutes <= Math.max(10, Number(repeatMinutes || 5) * 2);
