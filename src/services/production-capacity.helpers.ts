export type CapacitySlot = {
    key: string;
    startMinute: number;
    endMinute: number;
    kind: 'regular' | 'overtime';
    isActive: boolean;
};

export type CapacityBucket = {
    date: string;
    lineId: string;
    availableMinutes: number;
};

export type CapacitySuggestion = {
    date: string;
    lineId: string;
    quantity: number;
    minutes: number;
};

export type CapacityOccupiedWindow = {
    startSlotKey: string;
    endSlotKey: string;
};

export type CapacityReservedWindow = {
    startSlotKey: string;
    endSlotKey: string;
    reservedMinutes: number;
    slotKeys: string[];
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isValidCapacityDate = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const addCapacityDays = (date: string, days: number) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
};

export const capacityMonday = (date: string) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    const weekday = parsed.getUTCDay();
    return addCapacityDays(date, weekday === 0 ? -6 : 1 - weekday);
};

export const buildCapacityDates = (startDate: string, weeks: number) =>
    Array.from({ length: weeks * 7 }, (_, index) => addCapacityDays(startDate, index));

export const medianCapacityRate = (values: number[]) => {
    const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const capacityMinutesForAllocation = (slots: CapacitySlot[], startSlotKey: string, endSlotKey: string) => {
    const active = slots
        .filter((slot) => slot.isActive !== false)
        .sort((left, right) => left.startMinute - right.startMinute);
    const startIndex = active.findIndex((slot) => slot.key === startSlotKey);
    const endIndex = active.findIndex((slot) => slot.key === endSlotKey);
    if (startIndex < 0 || endIndex < startIndex) return { regularMinutes: 0, overtimeMinutes: 0, valid: false };
    const selected = active.slice(startIndex, endIndex + 1);
    const duration = (kind: CapacitySlot['kind']) =>
        selected
            .filter((slot) => slot.kind === kind)
            .reduce((sum, slot) => sum + Math.max(0, slot.endMinute - slot.startMinute), 0);
    return { regularMinutes: duration('regular'), overtimeMinutes: duration('overtime'), valid: true };
};

export const reserveRegularCapacityWindow = ({
    slots,
    occupiedWindows,
    requiredMinutes,
}: {
    slots: CapacitySlot[];
    occupiedWindows: CapacityOccupiedWindow[];
    requiredMinutes: number;
}): CapacityReservedWindow | undefined => {
    if (!Number.isFinite(requiredMinutes) || requiredMinutes <= 0) return undefined;
    const activeSlots = slots
        .filter((slot) => slot.isActive !== false)
        .sort((left, right) => left.startMinute - right.startMinute);
    const slotIndex = new Map(activeSlots.map((slot, index) => [slot.key, index]));
    const occupied = new Set<number>();
    occupiedWindows.forEach((window) => {
        const start = slotIndex.get(window.startSlotKey);
        const end = slotIndex.get(window.endSlotKey);
        if (start === undefined || end === undefined || end < start) return;
        for (let index = start; index <= end; index += 1) occupied.add(index);
    });

    for (let start = 0; start < activeSlots.length; start += 1) {
        if (occupied.has(start) || activeSlots[start].kind !== 'regular') continue;
        let reservedMinutes = 0;
        const slotKeys: string[] = [];
        for (let end = start; end < activeSlots.length; end += 1) {
            const slot = activeSlots[end];
            if (occupied.has(end) || slot.kind !== 'regular') break;
            reservedMinutes += Math.max(0, slot.endMinute - slot.startMinute);
            slotKeys.push(slot.key);
            if (reservedMinutes + 0.0001 >= requiredMinutes) {
                return {
                    startSlotKey: slotKeys[0],
                    endSlotKey: slotKeys.at(-1)!,
                    reservedMinutes,
                    slotKeys,
                };
            }
        }
    }
    return undefined;
};

export const consumeCapacityForQuantity = ({
    buckets,
    quantity,
    hourlyRate,
    notBefore,
}: {
    buckets: CapacityBucket[];
    quantity: number;
    hourlyRate: number;
    notBefore: string;
}) => {
    let remaining = Math.max(0, Number(quantity || 0));
    let projectedCompletionDate: string | undefined;
    let consumedMinutes = 0;
    const allocations: CapacitySuggestion[] = [];
    if (remaining <= 0 || hourlyRate <= 0) {
        return { projectedCompletionDate, consumedMinutes, unallocatedQuantity: remaining, allocations };
    }
    for (const bucket of buckets) {
        if (bucket.date < notBefore || bucket.availableMinutes <= 0) continue;
        const possibleQuantity = Math.floor((bucket.availableMinutes * hourlyRate) / 60 + 0.0001);
        if (possibleQuantity <= 0) continue;
        const allocatedQuantity = Math.min(remaining, possibleQuantity);
        const usedMinutes = (allocatedQuantity * 60) / hourlyRate;
        bucket.availableMinutes = Math.max(0, bucket.availableMinutes - usedMinutes);
        consumedMinutes += usedMinutes;
        remaining = Math.max(0, remaining - allocatedQuantity);
        projectedCompletionDate = bucket.date;
        allocations.push({
            date: bucket.date,
            lineId: bucket.lineId,
            quantity: Number(allocatedQuantity.toFixed(2)),
            minutes: Number(usedMinutes.toFixed(2)),
        });
        if (remaining < 0.0001) break;
    }
    return {
        projectedCompletionDate,
        consumedMinutes: Number(consumedMinutes.toFixed(2)),
        unallocatedQuantity: remaining < 0.0001 ? 0 : Math.ceil(remaining - 0.0001),
        allocations,
    };
};
