const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

const shiftedVietnamDate = (date: Date) => new Date(date.getTime() + VIETNAM_OFFSET_MS);

const vietnamBoundary = (date: Date, end = false) => {
    const shifted = shiftedVietnamDate(date);
    const utc = Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
        end ? 23 : 0,
        end ? 59 : 0,
        end ? 59 : 0,
        end ? 999 : 0
    );
    return new Date(utc - VIETNAM_OFFSET_MS);
};

export const startOfVietnamDay = (date = new Date()) => vietnamBoundary(date, false);

export const endOfVietnamDay = (date = new Date()) => vietnamBoundary(date, true);

export const addVietnamDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const vietnamCalendarParts = (date = new Date()) => {
    const shifted = shiftedVietnamDate(date);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth(),
        day: shifted.getUTCDate(),
        weekday: shifted.getUTCDay(),
    };
};

export const vietnamDateLabel = (date = new Date()) => {
    const { year, month, day } = vietnamCalendarParts(date);
    return `${String(day).padStart(2, '0')}/${String(month + 1).padStart(2, '0')}/${year}`;
};
