import { BadRequestError } from '@/errors/customError';
import { buildTimeSlotLabel, DEFAULT_PRODUCTION_TIME_SLOTS } from './production.helpers';

export type ProductionScheduleSlot = {
    key: string;
    label: string;
    startMinute: number;
    endMinute: number;
    kind: 'regular' | 'overtime';
    isActive: boolean;
};

export const PRODUCTION_WEEKDAY_LABELS = [
    'Chủ Nhật',
    'Thứ Hai',
    'Thứ Ba',
    'Thứ Tư',
    'Thứ Năm',
    'Thứ Sáu',
    'Thứ Bảy',
] as const;

const cloneDefaultSlots = (): ProductionScheduleSlot[] =>
    DEFAULT_PRODUCTION_TIME_SLOTS.map((slot) => ({
        ...slot,
        kind: slot.kind as 'regular' | 'overtime',
        // Tăng ca là ngoại lệ phải bật chủ động, tránh nhắc nhập sai.
        isActive: slot.kind === 'overtime' ? false : slot.isActive,
    }));

export const productionWeekdayFromDate = (productionDate: string) => {
    const parsed = new Date(`${productionDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== productionDate) {
        throw new BadRequestError('Ngày sản xuất không hợp lệ');
    }
    return parsed.getUTCDay();
};

export const defaultProductionScheduleForWeekday = (weekday: number) => {
    const slots = cloneDefaultSlots();

    if (weekday === 6) {
        return {
            weekday,
            weekdayLabel: PRODUCTION_WEEKDAY_LABELS[weekday],
            isWorkingDay: true,
            timeSlots: slots.map((slot) =>
                slot.startMinute >= 17 * 60 ? { ...slot, kind: 'overtime' as const, isActive: false } : slot
            ),
        };
    }

    if (weekday === 0) {
        return {
            weekday,
            weekdayLabel: PRODUCTION_WEEKDAY_LABELS[weekday],
            isWorkingDay: false,
            timeSlots: slots.map((slot) => ({ ...slot, kind: 'overtime' as const, isActive: false })),
        };
    }

    return {
        weekday,
        weekdayLabel: PRODUCTION_WEEKDAY_LABELS[weekday],
        isWorkingDay: true,
        timeSlots: slots,
    };
};

export const normalizeProductionTimeSlots = (input: any[]): ProductionScheduleSlot[] => {
    const slots = input
        .map((slot) => {
            const startMinute = Number(slot.startMinute);
            const endMinute = Number(slot.endMinute);
            return {
                key: String(slot.key),
                label: buildTimeSlotLabel(startMinute, endMinute),
                startMinute,
                endMinute,
                kind: (slot.kind || 'regular') as 'regular' | 'overtime',
                isActive: slot.isActive !== false,
            };
        })
        .sort((left, right) => left.startMinute - right.startMinute);

    const activeSlots = slots.filter((slot) => slot.isActive);
    for (let index = 1; index < activeSlots.length; index += 1) {
        if (activeSlots[index].startMinute < activeSlots[index - 1].endMinute) {
            throw new BadRequestError(
                `Khung giờ ${activeSlots[index].label} bị chồng lên ${activeSlots[index - 1].label}`
            );
        }
    }
    return slots;
};

export const summarizeProductionScheduleSlots = (slots: ProductionScheduleSlot[]) => {
    const duration = (kind: ProductionScheduleSlot['kind']) =>
        slots
            .filter((slot) => slot.isActive && slot.kind === kind)
            .reduce((sum, slot) => sum + Math.max(0, slot.endMinute - slot.startMinute), 0);
    return {
        regularMinutes: duration('regular'),
        overtimeMinutes: duration('overtime'),
        activeSlotCount: slots.filter((slot) => slot.isActive).length,
    };
};
