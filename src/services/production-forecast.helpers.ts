type ForecastClock = {
    localDate: string;
    minuteOfDay: number;
    asOf: string;
};

type ForecastConfidence = 'low' | 'medium' | 'high';
type ForecastStatus = 'not_started' | 'on_track' | 'at_risk' | 'behind' | 'completed' | 'overdue';

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

const allocationMinutes = (allocation: any, slots: any[]) => {
    const startIndex = slots.findIndex((slot) => slot.key === allocation.startSlotKey);
    const endIndex = slots.findIndex((slot) => slot.key === allocation.endSlotKey);
    if (startIndex < 0 || endIndex < startIndex) return [];
    return slots.slice(startIndex, endIndex + 1).filter((slot) => slot.isActive !== false);
};

const elapsedMinutesForSlots = (productionDate: string, slots: any[], clock: ForecastClock) => {
    if (productionDate < clock.localDate) {
        return slots.reduce((sum, slot) => sum + Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)), 0);
    }
    if (productionDate > clock.localDate) return 0;
    return slots.reduce((sum, slot) => {
        const elapsed = Math.min(
            Math.max(clock.minuteOfDay - Number(slot.startMinute), 0),
            Math.max(0, Number(slot.endMinute) - Number(slot.startMinute))
        );
        return sum + elapsed;
    }, 0);
};

const confidenceFor = (reportedEntries: number, elapsedMinutes: number): ForecastConfidence => {
    if (reportedEntries >= 3 && elapsedMinutes >= 180) return 'high';
    if (reportedEntries >= 1 && elapsedMinutes >= 60) return 'medium';
    return 'low';
};

const statusFor = ({
    actual,
    planned,
    expected,
    projected,
    elapsedMinutes,
    isPast,
}: {
    actual: number;
    planned: number;
    expected: number;
    projected: number;
    elapsedMinutes: number;
    isPast: boolean;
}): ForecastStatus => {
    if (actual >= planned) return 'completed';
    if (isPast) return 'overdue';
    if (elapsedMinutes <= 0) return 'not_started';
    const pacePercent = expected > 0 ? (actual / expected) * 100 : 100;
    const projectedPercent = planned > 0 ? (projected / planned) * 100 : 100;
    if (pacePercent < 80 || projectedPercent < 80) return 'behind';
    if (pacePercent < 95 || projectedPercent < 95) return 'at_risk';
    return 'on_track';
};

export const buildProductionForecast = (plan: any, detail: any, clock: ForecastClock) => {
    if (!plan?.allocations?.length) {
        return {
            asOf: clock.asOf,
            summary: {
                plannedQuantity: 0,
                actualQuantity: 0,
                expectedToNow: 0,
                remainingQuantity: 0,
                projectedEndOfDay: 0,
                projectedCompletionPercent: 0,
                atRiskAllocations: 0,
                completedAllocations: 0,
                confidence: 'low' as ForecastConfidence,
            },
            allocations: [],
            alerts: [],
        };
    }

    const linesById = new Map((detail?.lines || []).map((line: any) => [String(line.lineId), line]));
    const activeSlots = [...(plan.timeSlots || [])]
        .filter((slot: any) => slot.isActive !== false)
        .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute));

    const allocations = plan.allocations.map((allocation: any) => {
        const allocationId = String(allocation.id || allocation._id);
        const line: any = linesById.get(String(allocation.lineId));
        const runs = (line?.runs || []).filter((run: any) => String(run.planAllocationId || '') === allocationId);
        const runIds = new Set(runs.map((run: any) => String(run.id || run._id)));
        const entries = (line?.entries || []).filter((entry: any) => runIds.has(String(entry.runId)));
        const actual = entries.reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
        const slots = allocationMinutes(allocation, activeSlots);
        const totalMinutes = slots.reduce(
            (sum: number, slot: any) => sum + Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)),
            0
        );
        const elapsedMinutes = elapsedMinutesForSlots(plan.productionDate, slots, clock);
        const planned = Number(allocation.plannedQuantity || 0);
        const expected = Math.min(planned, (Number(allocation.hourlyQuota || 0) * elapsedMinutes) / 60);
        let projected = planned;
        if (plan.productionDate < clock.localDate) projected = actual;
        else if (elapsedMinutes > 0) {
            projected = actual > 0 ? (actual / elapsedMinutes) * totalMinutes : 0;
        }
        projected = round(Math.max(actual, projected), 0);
        const status = statusFor({
            actual,
            planned,
            expected,
            projected,
            elapsedMinutes,
            isPast: plan.productionDate < clock.localDate,
        });
        const confidence = confidenceFor(entries.length, elapsedMinutes);
        return {
            allocationId,
            lineId: String(allocation.lineId),
            lineCode: allocation.lineCode,
            itemId: String(allocation.itemId),
            itemCode: allocation.itemCode,
            itemName: allocation.itemName,
            orderCode: allocation.orderCode,
            priority: allocation.priority || 'normal',
            startSlotKey: allocation.startSlotKey,
            endSlotKey: allocation.endSlotKey,
            plannedQuantity: planned,
            actualQuantity: actual,
            expectedToNow: round(expected, 0),
            remainingQuantity: Math.max(0, planned - actual),
            projectedEndOfDay: projected,
            projectedCompletionPercent: planned > 0 ? round((projected / planned) * 100) : 0,
            pacePercent: expected > 0 ? round((actual / expected) * 100) : 0,
            elapsedMinutes,
            totalMinutes,
            reportedEntries: entries.length,
            confidence,
            status,
            sourceType: allocation.sourceType || 'manual',
        };
    });

    const alerts = allocations
        .filter((allocation: any) => ['at_risk', 'behind', 'overdue'].includes(allocation.status))
        .map((allocation: any) => {
            const overdue = allocation.status === 'overdue';
            const severe = overdue || allocation.status === 'behind';
            return {
                id: `plan-${allocation.status}-${allocation.allocationId}`,
                type: overdue ? 'plan_overdue' : 'plan_at_risk',
                severity: severe ? 'critical' : 'warning',
                lineId: allocation.lineId,
                lineCode: allocation.lineCode,
                slotKey: allocation.startSlotKey,
                allocationId: allocation.allocationId,
                title: overdue
                    ? `${allocation.lineCode} còn thiếu ${allocation.remainingQuantity.toLocaleString('vi-VN')} SP`
                    : `${allocation.lineCode} dự kiến chỉ đạt ${allocation.projectedCompletionPercent}%`,
                description: `${allocation.itemCode}${allocation.orderCode ? ` · ${allocation.orderCode}` : ''}: ${allocation.actualQuantity.toLocaleString('vi-VN')}/${allocation.plannedQuantity.toLocaleString('vi-VN')} SP.`,
            };
        });

    const plannedQuantity = allocations.reduce((sum: number, allocation: any) => sum + allocation.plannedQuantity, 0);
    const actualQuantity = allocations.reduce((sum: number, allocation: any) => sum + allocation.actualQuantity, 0);
    const expectedToNow = allocations.reduce((sum: number, allocation: any) => sum + allocation.expectedToNow, 0);
    const projectedEndOfDay = allocations.reduce(
        (sum: number, allocation: any) => sum + allocation.projectedEndOfDay,
        0
    );
    const confidenceCounts = allocations.reduce(
        (counts: Record<ForecastConfidence, number>, allocation: any) => {
            counts[allocation.confidence as ForecastConfidence] += 1;
            return counts;
        },
        { low: 0, medium: 0, high: 0 }
    );
    const confidence: ForecastConfidence =
        confidenceCounts.high >= Math.ceil(allocations.length / 2)
            ? 'high'
            : confidenceCounts.medium + confidenceCounts.high >= Math.ceil(allocations.length / 2)
              ? 'medium'
              : 'low';

    return {
        asOf: clock.asOf,
        summary: {
            plannedQuantity,
            actualQuantity,
            expectedToNow,
            remainingQuantity: Math.max(0, plannedQuantity - actualQuantity),
            projectedEndOfDay,
            projectedCompletionPercent: plannedQuantity > 0 ? round((projectedEndOfDay / plannedQuantity) * 100) : 0,
            atRiskAllocations: allocations.filter((allocation: any) =>
                ['at_risk', 'behind', 'overdue'].includes(allocation.status)
            ).length,
            completedAllocations: allocations.filter((allocation: any) => allocation.status === 'completed').length,
            confidence,
        },
        allocations,
        alerts,
    };
};
