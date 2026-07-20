type ProductionReportScope = 'all' | 'locked';

type BuildProductionReportOptions = {
    plantId: string;
    plantName?: string;
    plantCode?: string;
    from: string;
    to: string;
    scope: ProductionReportScope;
    financialsVisible: boolean;
    generatedAt?: string;
    previousFrom?: string;
    previousTo?: string;
    previousDetails?: any[];
    previousPlans?: any[];
    exceptionLimit?: number;
};

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const percentage = (value: number, total: number) => (total > 0 ? round((value / total) * 100, 1) : 0);
const percentChange = (value: number, previous: number) =>
    previous > 0 ? round(((value - previous) / previous) * 100, 1) : value > 0 ? null : 0;
const toId = (value: unknown) => String((value as any)?._id ?? value ?? '');

const planAllocations = (plans: any[]) =>
    plans.flatMap((plan) =>
        (plan.allocations || []).map((allocation: any) => ({
            ...allocation,
            id: toId(allocation),
            productionDate: plan.productionDate,
        }))
    );

const reportingForLine = (line: any) => {
    const expected = (line.slotValues || []).filter((slot: any) => Boolean(slot.runId));
    return {
        expected: expected.length,
        reported: expected.filter((slot: any) => slot.reported).length,
    };
};

const buildCoreReport = (details: any[], plans: any[], financialsVisible: boolean) => {
    const allocations = planAllocations(plans);
    const allocationById = new Map(allocations.map((allocation: any) => [allocation.id, allocation]));
    const planByDate = new Map(plans.map((plan) => [String(plan.productionDate), plan]));
    const lineMap = new Map<string, any>();
    const itemMap = new Map<string, any>();
    const exceptions: any[] = [];

    const ensureLine = (source: any) => {
        const key = String(source.lineId || source.lineCode || 'unknown-line');
        if (!lineMap.has(key)) {
            lineMap.set(key, {
                lineId: source.lineId || key,
                lineCode: source.lineCode || 'N/A',
                lineName: source.lineName,
                leaderName: source.leaderName,
                activeDays: new Set<string>(),
                workerDays: 0,
                targetQuantity: 0,
                actualQuantity: 0,
                plannedQuantity: 0,
                plannedActualQuantity: 0,
                expectedReports: 0,
                reportedEntries: 0,
                underTargetDays: 0,
                totalAmount: 0,
            });
        }
        return lineMap.get(key);
    };

    const ensureItem = (source: any) => {
        const key = String(source.itemId || source.itemCode || 'unknown-item');
        if (!itemMap.has(key)) {
            itemMap.set(key, {
                itemId: source.itemId || key,
                itemCode: source.itemCode || 'N/A',
                itemName: source.itemName,
                unit: source.unit || 'SP',
                activeDays: new Set<string>(),
                lineIds: new Set<string>(),
                targetQuantity: 0,
                actualQuantity: 0,
                plannedQuantity: 0,
                plannedActualQuantity: 0,
                totalAmount: 0,
            });
        }
        return itemMap.get(key);
    };

    allocations.forEach((allocation: any) => {
        const line = ensureLine(allocation);
        line.plannedQuantity += Number(allocation.plannedQuantity || 0);
        const item = ensureItem(allocation);
        item.plannedQuantity += Number(allocation.plannedQuantity || 0);
        item.lineIds.add(String(allocation.lineId || allocation.lineCode));
        item.activeDays.add(String(allocation.productionDate));
    });

    const trend = details.map((detail) => {
        const dayPlan: any = planByDate.get(String(detail.productionDate));
        const dayAllocationIds = new Set(
            (dayPlan?.allocations || []).map((allocation: any) => toId(allocation)).filter(Boolean)
        );
        let expectedReports = 0;
        let reportedEntries = 0;
        let plannedActualQuantity = 0;

        if (detail.status !== 'locked') {
            exceptions.push({
                id: `day-${detail.id}`,
                type: 'open_day',
                severity: detail.status === 'submitted' ? 'warning' : 'info',
                productionDate: detail.productionDate,
                title: detail.status === 'submitted' ? 'Ngày đang chờ khóa sổ' : 'Ngày vẫn đang nhập liệu',
                description: 'Số liệu chưa phải số chính thức đã khóa sổ.',
            });
        }

        (detail.lines || []).forEach((line: any) => {
            const lineAggregate = ensureLine(line);
            const reporting = reportingForLine(line);
            expectedReports += reporting.expected;
            reportedEntries += reporting.reported;
            lineAggregate.expectedReports += reporting.expected;
            lineAggregate.reportedEntries += reporting.reported;
            lineAggregate.workerDays += Number(line.workerCount || 0);
            lineAggregate.targetQuantity += Number(line.totalTarget || 0);
            lineAggregate.actualQuantity += Number(line.totalActual || 0);
            lineAggregate.totalAmount += Number(line.totalAmount || 0);
            if (line.configured || Number(line.totalActual || 0) > 0) {
                lineAggregate.activeDays.add(String(detail.productionDate));
            }
            if (line.configured && Number(line.totalTarget || 0) > 0 && Number(line.achievementPercent || 0) < 80) {
                lineAggregate.underTargetDays += 1;
                exceptions.push({
                    id: `under-${detail.id}-${line.lineId}`,
                    type: 'under_target',
                    severity: Number(line.achievementPercent || 0) < 60 ? 'critical' : 'warning',
                    productionDate: detail.productionDate,
                    lineId: line.lineId,
                    lineCode: line.lineCode,
                    title: `${line.lineCode} hụt khoán`,
                    description: `Chỉ đạt ${round(Number(line.achievementPercent || 0), 1)}% trong ngày.`,
                    value: round(Number(line.achievementPercent || 0), 1),
                });
            }
            if (!line.configured) {
                exceptions.push({
                    id: `unconfigured-${detail.id}-${line.lineId}`,
                    type: 'unconfigured_line',
                    severity: 'warning',
                    productionDate: detail.productionDate,
                    lineId: line.lineId,
                    lineCode: line.lineCode,
                    title: `${line.lineCode} chưa đủ cấu hình`,
                    description: 'Chưa xác nhận nhân sự hoặc chưa gán mã hàng.',
                });
            }

            const runById = new Map((line.runs || []).map((run: any) => [String(run.id), run]));
            (line.slotValues || []).forEach((slot: any) => {
                if (!slot.runId) return;
                const run: any = runById.get(String(slot.runId));
                if (!run) return;
                const item = ensureItem(run);
                item.targetQuantity += Number(slot.target || 0);
                item.activeDays.add(String(detail.productionDate));
                item.lineIds.add(String(line.lineId));
                if (!slot.reported) {
                    const slotLabel =
                        detail.timeSlots?.find((itemSlot: any) => itemSlot.key === slot.key)?.label || slot.key;
                    exceptions.push({
                        id: `missing-${detail.id}-${line.lineId}-${slot.key}`,
                        type: 'missing_report',
                        severity: 'critical',
                        productionDate: detail.productionDate,
                        lineId: line.lineId,
                        lineCode: line.lineCode,
                        slotKey: slot.key,
                        slotLabel,
                        title: `${line.lineCode} thiếu báo ${slotLabel}`,
                        description: `Mã ${run.itemCode || 'không xác định'} chưa có sản lượng.`,
                    });
                }
            });

            (line.entries || []).forEach((entry: any) => {
                const run: any = runById.get(String(entry.runId));
                if (!run) return;
                const quantity = Number(entry.quantity || 0);
                const item = ensureItem(run);
                item.actualQuantity += quantity;
                item.totalAmount += Number(entry.amount || 0);
                item.activeDays.add(String(detail.productionDate));
                item.lineIds.add(String(line.lineId));
                const allocationId = String(run.planAllocationId || '');
                if (allocationId && dayAllocationIds.has(allocationId) && allocationById.has(allocationId)) {
                    plannedActualQuantity += quantity;
                    lineAggregate.plannedActualQuantity += quantity;
                    item.plannedActualQuantity += quantity;
                }
                if (quantity === 0 && !String(entry.note || '').trim()) {
                    const slotLabel =
                        detail.timeSlots?.find((slot: any) => slot.key === entry.slotKey)?.label || entry.slotKey;
                    exceptions.push({
                        id: `zero-${detail.id}-${entry.id}`,
                        type: 'zero_without_note',
                        severity: 'warning',
                        productionDate: detail.productionDate,
                        lineId: line.lineId,
                        lineCode: line.lineCode,
                        slotKey: entry.slotKey,
                        slotLabel,
                        title: `${line.lineCode} báo 0 không có lý do`,
                        description: `Khung ${slotLabel}, mã ${run.itemCode || 'không xác định'}.`,
                    });
                }
            });
        });

        const plannedQuantity = (dayPlan?.allocations || []).reduce(
            (sum: number, allocation: any) => sum + Number(allocation.plannedQuantity || 0),
            0
        );
        return {
            productionDate: detail.productionDate,
            status: detail.status,
            targetQuantity: Number(detail.summary?.totalTarget || 0),
            actualQuantity: Number(detail.summary?.totalActual || 0),
            achievementPercent: Number(detail.summary?.achievementPercent || 0),
            plannedQuantity,
            plannedActualQuantity,
            planAttainmentPercent: percentage(plannedActualQuantity, plannedQuantity),
            expectedReports,
            reportedEntries,
            reportingRate: percentage(reportedEntries, expectedReports),
            workers: Number(detail.summary?.totalWorkers || 0),
            configuredLines: Number(detail.summary?.configuredLineCount || 0),
            totalLines: Number(detail.summary?.lineCount || 0),
            ...(financialsVisible ? { totalAmount: Number(detail.summary?.totalAmount || 0) } : {}),
        };
    });

    const totalTarget = trend.reduce((sum, day) => sum + day.targetQuantity, 0);
    const totalActual = trend.reduce((sum, day) => sum + day.actualQuantity, 0);
    const totalPlanned = trend.reduce((sum, day) => sum + day.plannedQuantity, 0);
    const totalPlannedActual = trend.reduce((sum, day) => sum + day.plannedActualQuantity, 0);
    const totalExpectedReports = trend.reduce((sum, day) => sum + day.expectedReports, 0);
    const totalReportedEntries = trend.reduce((sum, day) => sum + day.reportedEntries, 0);
    const totalWorkerDays = trend.reduce((sum, day) => sum + day.workers, 0);
    const totalAmount = financialsVisible
        ? trend.reduce((sum, day) => sum + Number(day.totalAmount || 0), 0)
        : undefined;
    const statusCounts = {
        draft: details.filter((day) => day.status === 'draft').length,
        submitted: details.filter((day) => day.status === 'submitted').length,
        locked: details.filter((day) => day.status === 'locked').length,
    };

    const lines = [...lineMap.values()]
        .map((line) => ({
            lineId: line.lineId,
            lineCode: line.lineCode,
            lineName: line.lineName,
            leaderName: line.leaderName,
            activeDays: line.activeDays.size,
            averageWorkers: line.activeDays.size > 0 ? round(line.workerDays / line.activeDays.size, 1) : 0,
            targetQuantity: round(line.targetQuantity, 1),
            actualQuantity: round(line.actualQuantity, 1),
            achievementPercent: percentage(line.actualQuantity, line.targetQuantity),
            plannedQuantity: round(line.plannedQuantity, 1),
            plannedActualQuantity: round(line.plannedActualQuantity, 1),
            planAttainmentPercent: percentage(line.plannedActualQuantity, line.plannedQuantity),
            reportingRate: percentage(line.reportedEntries, line.expectedReports),
            outputPerWorkerDay: line.workerDays > 0 ? round(line.actualQuantity / line.workerDays, 1) : 0,
            underTargetDays: line.underTargetDays,
            ...(financialsVisible ? { totalAmount: round(line.totalAmount, 0) } : {}),
        }))
        .sort(
            (left, right) => right.actualQuantity - left.actualQuantity || left.lineCode.localeCompare(right.lineCode)
        );

    const items = [...itemMap.values()]
        .map((item) => ({
            itemId: item.itemId,
            itemCode: item.itemCode,
            itemName: item.itemName,
            unit: item.unit,
            activeDays: item.activeDays.size,
            lineCount: item.lineIds.size,
            targetQuantity: round(item.targetQuantity, 1),
            actualQuantity: round(item.actualQuantity, 1),
            achievementPercent: percentage(item.actualQuantity, item.targetQuantity),
            plannedQuantity: round(item.plannedQuantity, 1),
            plannedActualQuantity: round(item.plannedActualQuantity, 1),
            planAttainmentPercent: percentage(item.plannedActualQuantity, item.plannedQuantity),
            ...(financialsVisible ? { totalAmount: round(item.totalAmount, 0) } : {}),
        }))
        .sort(
            (left, right) => right.actualQuantity - left.actualQuantity || left.itemCode.localeCompare(right.itemCode)
        );

    const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    exceptions.sort(
        (left, right) =>
            Number(severityRank[left.severity] ?? 9) - Number(severityRank[right.severity] ?? 9) ||
            String(right.productionDate).localeCompare(String(left.productionDate)) ||
            String(left.lineCode || '').localeCompare(String(right.lineCode || ''))
    );

    const reportingRate = percentage(totalReportedEntries, totalExpectedReports);
    const achievementPercent = percentage(totalActual, totalTarget);
    const health =
        reportingRate < 90 || (totalTarget > 0 && achievementPercent < 80)
            ? 'critical'
            : reportingRate < 98 || (totalTarget > 0 && achievementPercent < 95)
              ? 'warning'
              : 'healthy';

    return {
        summary: {
            dayCount: details.length,
            statusCounts,
            targetQuantity: round(totalTarget, 1),
            actualQuantity: round(totalActual, 1),
            achievementPercent,
            plannedQuantity: round(totalPlanned, 1),
            plannedActualQuantity: round(totalPlannedActual, 1),
            planAttainmentPercent: percentage(totalPlannedActual, totalPlanned),
            expectedReports: totalExpectedReports,
            reportedEntries: totalReportedEntries,
            reportingRate,
            averageWorkers: details.length > 0 ? round(totalWorkerDays / details.length, 1) : 0,
            outputPerWorkerDay: totalWorkerDays > 0 ? round(totalActual / totalWorkerDays, 1) : 0,
            averageDailyActual: details.length > 0 ? round(totalActual / details.length, 1) : 0,
            lineCount: lines.length,
            itemCount: items.length,
            exceptionCount: exceptions.length,
            health,
            ...(financialsVisible ? { totalAmount: round(totalAmount || 0, 0) } : {}),
        },
        trend,
        lines,
        items,
        exceptions,
    };
};

export const buildProductionReport = (details: any[], plans: any[], options: BuildProductionReportOptions) => {
    const current = buildCoreReport(details, plans, options.financialsVisible);
    const previous = buildCoreReport(
        options.previousDetails || [],
        options.previousPlans || [],
        options.financialsVisible
    );
    const previousAvailable = previous.summary.dayCount > 0;
    const bestLine = current.lines
        .filter((line) => line.targetQuantity > 0)
        .sort((left, right) => right.achievementPercent - left.achievementPercent)[0];
    const attentionLine = current.lines
        .filter((line) => line.targetQuantity > 0)
        .sort((left, right) => left.achievementPercent - right.achievementPercent)[0];
    const topItem = current.items[0];
    // Không dùng Number.isFinite: export truyền Infinity với nghĩa "xuất toàn bộ ngoại lệ".
    const exceptionLimit = Math.max(0, options.exceptionLimit ?? 200);

    return {
        meta: {
            plantId: options.plantId,
            plantName: options.plantName,
            plantCode: options.plantCode,
            from: options.from,
            to: options.to,
            scope: options.scope,
            generatedAt: options.generatedAt || new Date().toISOString(),
            financialsVisible: options.financialsVisible,
        },
        summary: current.summary,
        comparison: {
            available: previousAvailable,
            from: options.previousFrom,
            to: options.previousTo,
            previous: previousAvailable ? previous.summary : undefined,
            delta: previousAvailable
                ? {
                      actualPercent: percentChange(current.summary.actualQuantity, previous.summary.actualQuantity),
                      achievementPoints: round(
                          current.summary.achievementPercent - previous.summary.achievementPercent,
                          1
                      ),
                      reportingPoints: round(current.summary.reportingRate - previous.summary.reportingRate, 1),
                      productivityPercent: percentChange(
                          current.summary.outputPerWorkerDay,
                          previous.summary.outputPerWorkerDay
                      ),
                      ...(options.financialsVisible
                          ? {
                                amountPercent: percentChange(
                                    Number(current.summary.totalAmount || 0),
                                    Number(previous.summary.totalAmount || 0)
                                ),
                            }
                          : {}),
                  }
                : undefined,
        },
        highlights: {
            bestLine: bestLine
                ? {
                      lineId: bestLine.lineId,
                      lineCode: bestLine.lineCode,
                      achievementPercent: bestLine.achievementPercent,
                  }
                : undefined,
            attentionLine: attentionLine
                ? {
                      lineId: attentionLine.lineId,
                      lineCode: attentionLine.lineCode,
                      achievementPercent: attentionLine.achievementPercent,
                  }
                : undefined,
            topItem: topItem
                ? { itemId: topItem.itemId, itemCode: topItem.itemCode, actualQuantity: topItem.actualQuantity }
                : undefined,
        },
        trend: current.trend,
        lines: current.lines,
        items: current.items,
        exceptionSummary: {
            total: current.exceptions.length,
            critical: current.exceptions.filter((item) => item.severity === 'critical').length,
            warning: current.exceptions.filter((item) => item.severity === 'warning').length,
            info: current.exceptions.filter((item) => item.severity === 'info').length,
            missingReports: current.exceptions.filter((item) => item.type === 'missing_report').length,
            underTarget: current.exceptions.filter((item) => item.type === 'under_target').length,
            zeroWithoutNote: current.exceptions.filter((item) => item.type === 'zero_without_note').length,
            unconfiguredLines: current.exceptions.filter((item) => item.type === 'unconfigured_line').length,
            openDays: current.exceptions.filter((item) => item.type === 'open_day').length,
        },
        exceptions: current.exceptions.slice(0, exceptionLimit),
    };
};
