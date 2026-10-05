export type NotebookAttendanceType = 'full' | 'half' | 'off';

type AttendanceRecord = {
    attended?: boolean;
    attendanceType?: string | null;
    overtimeHours?: number | null;
};

type ReportEntry = { itemCode: string; operation: string; unit: string; quantity: number };
type ReportDay = AttendanceRecord & { date: string; entries: ReportEntry[] };

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// Old notebook records stored only a boolean attendance marker.
export const notebookAttendance = (day: AttendanceRecord) => {
    const attendanceType: NotebookAttendanceType =
        day.attendanceType === 'full' || day.attendanceType === 'half' || day.attendanceType === 'off'
            ? day.attendanceType
            : day.attended
              ? 'full'
              : 'off';
    return {
        attendanceType,
        attended: attendanceType !== 'off',
        workDays: attendanceType === 'full' ? 1 : attendanceType === 'half' ? 0.5 : 0,
        overtimeHours: day.overtimeHours ?? 0,
    };
};

const unitTotals = (entries: ReportEntry[]) => {
    const groups = new Map<string, number>();
    for (const entry of entries) groups.set(entry.unit, (groups.get(entry.unit) ?? 0) + entry.quantity);
    return [...groups]
        .map(([unit, quantity]) => ({ unit, quantity: round(quantity) }))
        .sort((a, b) => a.unit.localeCompare(b.unit, 'vi'));
};

export const notebookMonthSummary = (records: ReportDay[]) => {
    const groups = new Map<string, ReportEntry & { dates: Set<string> }>();
    for (const day of records) {
        for (const entry of day.entries) {
            const key = JSON.stringify([entry.itemCode, entry.operation, entry.unit]);
            const current = groups.get(key) ?? {
                itemCode: entry.itemCode,
                operation: entry.operation,
                unit: entry.unit,
                quantity: 0,
                dates: new Set<string>(),
            };
            current.quantity += entry.quantity;
            current.dates.add(day.date);
            groups.set(key, current);
        }
    }
    const days = records.map((day) => ({
        date: day.date,
        ...notebookAttendance(day),
        entryCount: day.entries.length,
        totalsByUnit: unitTotals(day.entries),
    }));
    return {
        attendedDays: days.filter((day) => day.attended).length,
        fullDays: days.filter((day) => day.attendanceType === 'full').length,
        halfDays: days.filter((day) => day.attendanceType === 'half').length,
        workDays: days.reduce((total, day) => total + day.workDays, 0),
        overtimeHours: round(days.reduce((total, day) => total + day.overtimeHours, 0)),
        productionDays: days.filter((day) => day.entryCount > 0).length,
        entryCount: days.reduce((total, day) => total + day.entryCount, 0),
        totalsByUnit: unitTotals(records.flatMap((day) => day.entries)),
        days,
        breakdown: [...groups.values()]
            .map(({ dates, ...entry }) => ({
                ...entry,
                quantity: round(entry.quantity),
                recordedDays: dates.size,
            }))
            .sort((a, b) => a.itemCode.localeCompare(b.itemCode, 'vi') || a.operation.localeCompare(b.operation, 'vi')),
    };
};
