import { vietnamCalendarParts } from '@/utils/vietnamDate';

export type AssistantDateSelection = {
    period?: 'today' | 'yesterday' | 'week' | 'month';
    startDate?: string;
    endDate?: string;
};

const validYmd = (year: number, month: number, day: number) => {
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return undefined;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const parseDateToken = (token: string, currentYear: number) => {
    const iso = token.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const local = token.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?$/);
    if (!local) return undefined;
    return validYmd(Number(local[3] || currentYear), Number(local[2]), Number(local[1]));
};

export const detectAssistantDateSelection = (question: string, now = new Date()): AssistantDateSelection => {
    const normalized = question.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

    if (normalized.includes('hom nay')) return { period: 'today' };
    if (normalized.includes('hom qua')) return { period: 'yesterday' };

    const tokens = question.match(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{4})?)\b/g) || [];
    const currentYear = vietnamCalendarParts(now).year;
    const dates = tokens
        .map((token) => parseDateToken(token, currentYear))
        .filter((date): date is string => Boolean(date));
    if (dates.length) return { startDate: dates[0], endDate: dates[1] || dates[0] };

    if (normalized.includes('tuan')) return { period: 'week' };
    if (normalized.includes('thang')) return { period: 'month' };
    return {};
};
