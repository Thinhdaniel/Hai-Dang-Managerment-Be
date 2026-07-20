type MonitorClock = {
    localDate: string;
    minuteOfDay: number;
    asOf: string;
};

type MonitorAlertSeverity = 'critical' | 'warning' | 'info';

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

const severityRank: Record<MonitorAlertSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
};

const slotPercent = (actual: number, target: number) => (target > 0 ? (actual / target) * 100 : 0);

const statusForLine = ({
    configured,
    missingCount,
    achievement,
    hasZeroWithoutNote,
    dueCount,
    targetToNow,
}: {
    configured: boolean;
    missingCount: number;
    achievement: number;
    hasZeroWithoutNote: boolean;
    dueCount: number;
    targetToNow: number;
}) => {
    if (!configured) return 'not_configured';
    if (!dueCount || targetToNow <= 0) return 'waiting';
    if (missingCount > 0) return 'missing';
    if (hasZeroWithoutNote || achievement < 50) return 'critical';
    if (achievement < 80) return 'at_risk';
    return 'on_track';
};

const baselineByLine = (baselineDetails: any[]) => {
    const samples = new Map<string, number[]>();
    baselineDetails.forEach((detail) => {
        detail.lines.forEach((line: any) => {
            if (Number(line.totalTarget || 0) <= 0) return;
            const values = samples.get(String(line.lineId)) || [];
            values.push((Number(line.totalActual || 0) / Number(line.totalTarget || 0)) * 100);
            samples.set(String(line.lineId), values);
        });
    });
    return new Map(
        [...samples.entries()].map(([lineId, values]) => [
            lineId,
            round(values.reduce((sum, value) => sum + value, 0) / values.length),
        ])
    );
};

const dueSlotKeys = (detail: any, clock: MonitorClock) => {
    const activeSlots = detail.timeSlots.filter((slot: any) => slot.isActive);
    if (detail.productionDate < clock.localDate) return new Set(activeSlots.map((slot: any) => slot.key));
    if (detail.productionDate > clock.localDate) return new Set<string>();
    return new Set(
        activeSlots.filter((slot: any) => Number(slot.endMinute) <= clock.minuteOfDay).map((slot: any) => slot.key)
    );
};

const currentSlotKey = (detail: any, clock: MonitorClock) => {
    const activeSlots = detail.timeSlots.filter((slot: any) => slot.isActive);
    if (!activeSlots.length || detail.productionDate !== clock.localDate) return undefined;
    return activeSlots.find(
        (slot: any) => clock.minuteOfDay >= Number(slot.startMinute) && clock.minuteOfDay < Number(slot.endMinute)
    )?.key;
};

export const buildProductionMonitor = (detail: any, baselineDetails: any[], clock: MonitorClock) => {
    const dueKeys = dueSlotKeys(detail, clock);
    const baselines = baselineByLine(baselineDetails);
    const slotsByKey = new Map(detail.timeSlots.map((slot: any) => [String(slot.key), slot]));
    const alerts: any[] = [];

    const linePerformance = detail.lines.map((line: any) => {
        const dueValues = line.slotValues.filter((slot: any) => dueKeys.has(slot.key) && slot.runId);
        const missingValues = dueValues.filter((slot: any) => !slot.reported);
        const targetToNow = dueValues.reduce((sum: number, slot: any) => sum + Number(slot.target || 0), 0);
        const actualToNow = dueValues.reduce((sum: number, slot: any) => sum + Number(slot.actual || 0), 0);
        const achievement = slotPercent(actualToNow, targetToNow);
        let hasZeroWithoutNote = false;

        if (!line.configured && detail.productionDate <= clock.localDate) {
            alerts.push({
                id: `line-not-configured-${line.lineId}`,
                type: 'line_not_configured',
                severity: 'warning',
                lineId: line.lineId,
                lineCode: line.lineCode,
                title: `${line.lineCode} chưa xác nhận đầu ngày`,
                description: 'Chưa có đủ số công nhân và mã hàng đang chạy.',
            });
        }

        missingValues.forEach((slotValue: any) => {
            const slot: any = slotsByKey.get(String(slotValue.key));
            const minutesLate =
                detail.productionDate === clock.localDate
                    ? Math.max(0, clock.minuteOfDay - Number(slot?.endMinute || clock.minuteOfDay))
                    : 24 * 60;
            alerts.push({
                id: `missing-${line.lineId}-${slotValue.key}`,
                type: 'missing_report',
                severity: minutesLate >= 60 ? 'critical' : 'warning',
                lineId: line.lineId,
                lineCode: line.lineCode,
                slotKey: slotValue.key,
                slotLabel: slot?.label || slotValue.key,
                title: `${line.lineCode} chưa báo ${slot?.label || slotValue.key}`,
                description:
                    minutesLate >= 60
                        ? `Đã quá giờ ${Math.floor(minutesLate / 60)} giờ ${minutesLate % 60} phút.`
                        : `Khung giờ đã kết thúc ${minutesLate} phút.`,
            });
        });

        dueValues
            .filter((slot: any) => slot.reported)
            .forEach((slotValue: any) => {
                const target = Number(slotValue.target || 0);
                if (target <= 0) return;
                const percent = slotPercent(Number(slotValue.actual || 0), target);
                const entries = line.entries.filter((entry: any) => entry.slotKey === slotValue.key);
                const hasNote = entries.some((entry: any) => String(entry.note || '').trim());
                const slot: any = slotsByKey.get(String(slotValue.key));

                if (Number(slotValue.actual || 0) === 0 && !hasNote) {
                    hasZeroWithoutNote = true;
                    alerts.push({
                        id: `zero-no-note-${line.lineId}-${slotValue.key}`,
                        type: 'zero_without_note',
                        severity: 'warning',
                        lineId: line.lineId,
                        lineCode: line.lineCode,
                        slotKey: slotValue.key,
                        slotLabel: slot?.label || slotValue.key,
                        title: `${line.lineCode} báo 0 SP tại ${slot?.label || slotValue.key}`,
                        description: 'Sản lượng bằng 0 nhưng chưa có ghi chú giải thích.',
                    });
                    return;
                }

                if (percent < 80) {
                    alerts.push({
                        id: `low-output-${line.lineId}-${slotValue.key}`,
                        type: 'low_output',
                        severity: percent < 50 ? 'critical' : 'warning',
                        lineId: line.lineId,
                        lineCode: line.lineCode,
                        slotKey: slotValue.key,
                        slotLabel: slot?.label || slotValue.key,
                        title: `${line.lineCode} chỉ đạt ${round(percent)}% tại ${slot?.label || slotValue.key}`,
                        description: `${Number(slotValue.actual || 0).toLocaleString('vi-VN')}/${target.toLocaleString('vi-VN')} SP.`,
                    });
                } else if (percent > 160) {
                    alerts.push({
                        id: `output-spike-${line.lineId}-${slotValue.key}`,
                        type: 'output_spike',
                        severity: 'warning',
                        lineId: line.lineId,
                        lineCode: line.lineCode,
                        slotKey: slotValue.key,
                        slotLabel: slot?.label || slotValue.key,
                        title: `${line.lineCode} đạt ${round(percent)}% tại ${slot?.label || slotValue.key}`,
                        description: 'Sản lượng vượt xa khoán, cần kiểm tra khả năng nhập nhầm.',
                    });
                }
            });

        const baselineAchievement = baselines.get(String(line.lineId));
        return {
            lineId: line.lineId,
            lineCode: line.lineCode,
            lineName: line.lineName,
            leaderName: line.leaderName,
            workerCount: line.workerCount,
            configured: line.configured,
            targetToNow: round(targetToNow),
            actualToNow,
            achievementPercent: round(achievement),
            reportedSlots: dueValues.filter((slot: any) => slot.reported).length,
            dueSlots: dueValues.length,
            missingSlots: missingValues.map((slot: any) => slot.key),
            baselineAchievement,
            deltaVsBaseline:
                baselineAchievement === undefined || targetToNow <= 0
                    ? undefined
                    : round(achievement - baselineAchievement),
            status: statusForLine({
                configured: line.configured,
                missingCount: missingValues.length,
                achievement,
                hasZeroWithoutNote,
                dueCount: dueValues.length,
                targetToNow,
            }),
        };
    });

    const slotPerformance = detail.timeSlots
        .filter((slot: any) => slot.isActive)
        .map((slot: any) => {
            const values = detail.lines
                .map((line: any) => line.slotValues.find((value: any) => value.key === slot.key))
                .filter((value: any) => value?.runId);
            const target = values.reduce((sum: number, value: any) => sum + Number(value.target || 0), 0);
            const actual = values.reduce((sum: number, value: any) => sum + Number(value.actual || 0), 0);
            return {
                key: slot.key,
                label: slot.label,
                startMinute: slot.startMinute,
                endMinute: slot.endMinute,
                due: dueKeys.has(slot.key),
                target: round(target),
                actual,
                achievementPercent: round(slotPercent(actual, target)),
                reportedLines: values.filter((value: any) => value.reported).length,
                totalLines: values.length,
            };
        });

    alerts.sort(
        (left, right) =>
            severityRank[left.severity as MonitorAlertSeverity] -
                severityRank[right.severity as MonitorAlertSeverity] ||
            left.lineCode.localeCompare(right.lineCode) ||
            String(left.slotKey || '').localeCompare(String(right.slotKey || ''))
    );

    const dueValues = detail.lines.flatMap((line: any) =>
        line.slotValues.filter((slot: any) => dueKeys.has(slot.key) && slot.runId)
    );
    const targetToNow = dueValues.reduce((sum: number, slot: any) => sum + Number(slot.target || 0), 0);
    const actualToNow = dueValues.reduce((sum: number, slot: any) => sum + Number(slot.actual || 0), 0);
    const reportedSlots = dueValues.filter((slot: any) => slot.reported).length;
    const weightedBaselineTarget = baselineDetails.reduce(
        (sum, baseline) => sum + Number(baseline.summary.totalTarget || 0),
        0
    );
    const weightedBaselineActual = baselineDetails.reduce(
        (sum, baseline) => sum + Number(baseline.summary.totalActual || 0),
        0
    );

    return {
        asOf: clock.asOf,
        localDate: clock.localDate,
        minuteOfDay: clock.minuteOfDay,
        currentSlotKey: currentSlotKey(detail, clock),
        dueSlotKeys: [...dueKeys],
        summary: {
            configuredLines: detail.lines.filter((line: any) => line.configured).length,
            totalLines: detail.lines.length,
            targetToNow: round(targetToNow),
            actualToNow,
            achievementToNow: round(slotPercent(actualToNow, targetToNow)),
            reportedSlots,
            dueSlots: dueValues.length,
            reportingRate: dueValues.length ? round((reportedSlots / dueValues.length) * 100) : 0,
            onTrackLines: linePerformance.filter((line: any) => line.status === 'on_track').length,
            atRiskLines: linePerformance.filter((line: any) =>
                ['missing', 'critical', 'at_risk', 'not_configured'].includes(line.status)
            ).length,
            criticalAlerts: alerts.filter((alert) => alert.severity === 'critical').length,
            warningAlerts: alerts.filter((alert) => alert.severity === 'warning').length,
            baselineDays: baselineDetails.length,
            baselineAchievement:
                weightedBaselineTarget > 0 ? round((weightedBaselineActual / weightedBaselineTarget) * 100) : undefined,
        },
        alerts,
        linePerformance,
        slotPerformance,
    };
};
