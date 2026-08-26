import { createHash } from 'node:crypto';
import { allocateWholeUnitTargets, resolveRunForSlot } from './production.helpers';

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

export type ProductionReminderOperationState = {
    lineId: string;
    lineCode: string;
    trackId: string;
    operationCode: string;
    operationName: string;
    itemCode: string;
    label: string;
};

export type ProductionReminderSlotState = {
    slotKey: string;
    slotLabel: string;
    dueAt: Date;
    overdueMinutes: number;
    dueLineCount: number;
    reportedLineCount: number;
    missingLines: ProductionReminderLineState[];
    missingOperations: ProductionReminderOperationState[];
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
            [
                ...slots.flatMap((slot) =>
                    slot.missingLines.map((line) => `${slot.slotKey}:line:${line.lineId}:${line.lineCode}`)
                ),
                ...slots.flatMap((slot) =>
                    slot.missingOperations.map(
                        (operation) => `${slot.slotKey}:operation:${operation.lineId}:${operation.trackId}`
                    )
                ),
            ]
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
    const slotIndexByKey = new Map(slots.map((slot: any, index: number) => [String(slot.key), index]));
    const preparedRecords = recordInputs.map((input) => {
        const record = typeof input?.toObject === 'function' ? input.toObject() : input;
        const targetBySlot = allocateWholeUnitTargets(
            slots.map((slot: any) => {
                const run: any = resolveRunForSlot(record.runs || [], String(slot.key), slots);
                const durationHours = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)) / 60;
                return {
                    key: String(slot.key),
                    groupKey: run ? toId(run) : undefined,
                    exactTarget:
                        slot.isActive !== false && slot.kind !== 'overtime'
                            ? Number(run?.hourlyQuota || 0) * durationHours
                            : 0,
                };
            })
        );
        return { record, targetBySlot };
    });

    return slots
        .filter((slot: any) => slot.isActive !== false)
        .map((slot: any) => {
            const dueAt = new Date(
                productionMinuteToDate(String(day.productionDate), Number(slot.endMinute)).getTime() +
                    graceMinutes * MINUTE_MS
            );
            if (dueAt.getTime() > now.getTime()) return undefined;

            const dueLines: Array<ProductionReminderLineState & { reported: boolean }> = [];
            const missingOperations: ProductionReminderOperationState[] = [];
            preparedRecords.forEach(({ record, targetBySlot }) => {
                if (!record?.workerCountConfirmedAt || !(record.runs || []).length) return;
                const run: any = resolveRunForSlot(record.runs || [], String(slot.key), slots);
                if (!run) return;
                const entries = (record.entries || []).filter(
                    (entry: any) => String(entry.slotKey) === String(slot.key)
                );
                const actual = entries.reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
                const target = targetBySlot.get(String(slot.key)) || 0;
                dueLines.push({
                    lineId: toId(record.lineId),
                    lineCode: String(record.lineCode || 'N/A'),
                    actual,
                    target,
                    achievementPercent: target > 0 ? round((actual / target) * 100, 1) : 0,
                    reported: entries.length > 0,
                });

                const slotIndex = Number(slotIndexByKey.get(String(slot.key)) ?? -1);
                (record.operationTracks || []).forEach((track: any) => {
                    if (track.required === false) return;
                    const startIndex = Number(
                        slotIndexByKey.get(String(track.startedSlotKey)) ?? Number.MAX_SAFE_INTEGER
                    );
                    const endIndex = track.endedSlotKey
                        ? Number(slotIndexByKey.get(String(track.endedSlotKey)) ?? -1)
                        : Number.MAX_SAFE_INTEGER;
                    if (slotIndex < startIndex || slotIndex > endIndex) return;
                    const reported = (record.operationEntries || []).some(
                        (entry: any) =>
                            String(entry.slotKey) === String(slot.key) && toId(entry.trackId) === toId(track)
                    );
                    if (reported) return;
                    const lineCode = String(record.lineCode || 'N/A');
                    const operationCode = String(track.operationCode || 'CĐ');
                    const operationName = String(track.operationName || 'Công đoạn');
                    const itemCode = String(track.itemCode || 'N/A');
                    missingOperations.push({
                        lineId: toId(record.lineId),
                        lineCode,
                        trackId: toId(track),
                        operationCode,
                        operationName,
                        itemCode,
                        label: `${lineCode} · ${operationCode} · ${itemCode}`,
                    });
                });
            });

            const missingLines = dueLines
                .filter((line) => !line.reported)
                .map(({ reported: _reported, ...line }) => line);
            const underTargetLines =
                rule.underTargetEnabled === false || missingLines.length > 0 || missingOperations.length > 0
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
                missingOperations,
                underTargetLines,
            } satisfies ProductionReminderSlotState;
        })
        .filter((slot): slot is ProductionReminderSlotState => Boolean(slot));
};

export const buildProductionReminderCopy = (slots: ProductionReminderSlotState[], escalated: boolean) => {
    const missing = slots.flatMap((slot) => slot.missingLines);
    const missingOperations = slots.flatMap((slot) => slot.missingOperations);
    const uniqueLineCodes = [...new Set(missing.map((line) => line.lineCode))];
    const oldest = [...slots].sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0];
    const slotCopy =
        slots.length === 1
            ? `khung ${oldest?.slotLabel || slots[0].slotKey}`
            : `${slots.length} khung giờ, cũ nhất ${oldest?.slotLabel || ''}`;
    const preview = uniqueLineCodes.slice(0, 5).join(', ');
    const remaining = Math.max(0, uniqueLineCodes.length - 5);
    const uniqueOperationLabels = [...new Set(missingOperations.map((operation) => operation.label))];
    const operationPreview = uniqueOperationLabels.slice(0, 3).join(', ');
    const operationRemaining = Math.max(0, uniqueOperationLabels.length - 3);
    const title = escalated ? 'Quá hạn nhập sản lượng' : 'Nhắc nhập sản lượng';
    const countCopy = [
        uniqueLineCodes.length ? `${uniqueLineCodes.length} chuyền` : '',
        uniqueOperationLabels.length ? `${uniqueOperationLabels.length} công đoạn` : '',
    ]
        .filter(Boolean)
        .join(', ');
    const detailCopy = [
        uniqueLineCodes.length ? `sản lượng: ${preview}${remaining ? ` và ${remaining} chuyền khác` : ''}` : '',
        uniqueOperationLabels.length
            ? `công đoạn: ${operationPreview}${operationRemaining ? ` và ${operationRemaining} mục khác` : ''}`
            : '',
    ]
        .filter(Boolean)
        .join('; ');
    return {
        title: `${title}: ${countCopy}`,
        message: `${slotCopy} còn thiếu ${detailCopy}. Nhấn để nhập ngay.`,
        oldestSlotKey: oldest?.slotKey,
        missingLineCount: uniqueLineCodes.length,
        missingOperationCount: uniqueOperationLabels.length,
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
