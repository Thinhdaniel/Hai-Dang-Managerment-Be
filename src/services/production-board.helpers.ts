type ProductionBoardClock = {
    localDate: string;
    minuteOfDay: number;
    asOf: string;
};

type ProductionBoardLineStatus =
    | 'not_configured'
    | 'waiting'
    | 'missing'
    | 'critical'
    | 'at_risk'
    | 'on_track'
    | 'ahead';

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const percent = (actual: number, target: number) => (target > 0 ? round((actual / target) * 100) : 0);

const amountForEntry = (entry: any, runById: Map<string, any>) => {
    if (entry.amount !== undefined) return Number(entry.amount || 0);
    const run = runById.get(String(entry.runId));
    return Number(entry.quantity || 0) * Number(run?.unitPriceSnapshot || 0);
};

const elapsedForSlot = (productionDate: string, slot: any, clock: ProductionBoardClock) => {
    const duration = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute));
    if (productionDate < clock.localDate) return duration;
    if (productionDate > clock.localDate) return 0;
    return clamp(clock.minuteOfDay - Number(slot.startMinute), 0, duration);
};

const isDueSlot = (productionDate: string, slot: any, clock: ProductionBoardClock) => {
    if (productionDate < clock.localDate) return true;
    if (productionDate > clock.localDate) return false;
    return Number(slot.endMinute) <= clock.minuteOfDay;
};

const isStartedSlot = (productionDate: string, slot: any, clock: ProductionBoardClock) => {
    if (productionDate < clock.localDate) return true;
    if (productionDate > clock.localDate) return false;
    return Number(slot.startMinute) <= clock.minuteOfDay;
};

const statusForLine = ({
    configured,
    missingCount,
    checkpointTarget,
    achievement,
}: {
    configured: boolean;
    missingCount: number;
    checkpointTarget: number;
    achievement: number;
}): ProductionBoardLineStatus => {
    if (!configured) return 'not_configured';
    if (missingCount > 0) return 'missing';
    if (checkpointTarget <= 0) return 'waiting';
    if (achievement < 80) return 'critical';
    if (achievement < 95) return 'at_risk';
    if (achievement >= 105) return 'ahead';
    return 'on_track';
};

const guidanceForLine = ({
    status,
    lineCode,
    missingLabels,
    checkpointGap,
    currentSlot,
}: {
    status: ProductionBoardLineStatus;
    lineCode: string;
    missingLabels: string[];
    checkpointGap: number;
    currentSlot?: any;
}) => {
    if (status === 'not_configured') {
        return {
            tone: 'neutral',
            title: 'Chưa xác nhận đầu ngày',
            description: 'Tổ trưởng cần xác nhận số công nhân và mã hàng đang chạy.',
        };
    }
    if (status === 'missing') {
        return {
            tone: 'warning',
            title: `Đang thiếu báo cáo ${missingLabels.slice(0, 2).join(', ')}`,
            description: 'Cần nhập đủ sản lượng trước khi kết luận chuyền đang nhanh hay chậm.',
        };
    }
    if (status === 'waiting') {
        if (currentSlot) {
            return {
                tone: 'info',
                title: 'Khung sản xuất đầu tiên đang chạy',
                description: `Duy trì khoảng ${currentSlot.basePer15.toLocaleString('vi-VN')} SP mỗi 15 phút.`,
            };
        }
        return {
            tone: 'neutral',
            title: 'Chưa đến giờ sản xuất',
            description: 'Bảng sẽ tự cập nhật khi khung sản xuất bắt đầu.',
        };
    }
    if (status === 'critical' || status === 'at_risk') {
        if (currentSlot) {
            return {
                tone: status === 'critical' ? 'danger' : 'warning',
                title: `Đang chậm ${Math.abs(checkpointGap).toLocaleString('vi-VN')} SP`,
                description: `Khung này cần đạt ${currentSlot.requiredQuantity.toLocaleString('vi-VN')} SP, tương đương ${currentSlot.requiredPer15.toLocaleString('vi-VN')} SP mỗi 15 phút.`,
            };
        }
        return {
            tone: status === 'critical' ? 'danger' : 'warning',
            title: `Kết quả còn thiếu ${Math.abs(checkpointGap).toLocaleString('vi-VN')} SP`,
            description: 'Tổ trưởng cần kiểm tra nguyên nhân máy, vật tư hoặc công đoạn.',
        };
    }
    if (status === 'ahead') {
        return {
            tone: 'success',
            title: `Đang vượt nhịp ${Math.max(0, checkpointGap).toLocaleString('vi-VN')} SP`,
            description: currentSlot
                ? `Tiếp tục duy trì khoảng ${currentSlot.basePer15.toLocaleString('vi-VN')} SP mỗi 15 phút.`
                : 'Kết quả sản xuất đang vượt mức khoán.',
        };
    }
    return {
        tone: 'success',
        title: 'Đang đúng nhịp sản xuất',
        description: currentSlot
            ? `Duy trì khoảng ${currentSlot.basePer15.toLocaleString('vi-VN')} SP mỗi 15 phút.`
            : `${lineCode} đã giữ được tiến độ khoán.`,
    };
};

const buildBoardLine = (line: any, detail: any, clock: ProductionBoardClock) => {
    const slots = [...detail.timeSlots]
        .filter((slot: any) => slot.isActive !== false)
        .sort((left: any, right: any) => Number(left.startMinute) - Number(right.startMinute));
    const slotByKey = new Map<string, any>(slots.map((slot: any) => [String(slot.key), slot]));
    const slotValueByKey = new Map<string, any>(line.slotValues.map((value: any) => [String(value.key), value]));
    const runById = new Map<string, any>(line.runs.map((run: any) => [String(run.id), run]));
    const entriesBySlot = new Map<string, any[]>();
    line.entries.forEach((entry: any) => {
        const key = String(entry.slotKey);
        const entries = entriesBySlot.get(key) || [];
        entries.push(entry);
        entriesBySlot.set(key, entries);
    });

    const currentSlotBase =
        detail.productionDate === clock.localDate
            ? slots.find(
                  (slot: any) =>
                      clock.minuteOfDay >= Number(slot.startMinute) && clock.minuteOfDay < Number(slot.endMinute)
              )
            : undefined;

    let targetToNow = 0;
    let checkpointTarget = 0;
    let checkpointActual = 0;
    let targetAmountToNow = 0;
    let checkpointTargetAmount = 0;
    let checkpointActualAmount = 0;
    let actualToNow = 0;
    let actualAmountToNow = 0;
    let dayTarget = 0;
    let dayTargetAmount = 0;
    let remainingActiveMinutes = 0;
    const missingSlots: string[] = [];

    const boardSlots = slots.map((slot: any) => {
        const value: any = slotValueByKey.get(String(slot.key));
        const run: any = value?.runId ? runById.get(String(value.runId)) : undefined;
        const entries = entriesBySlot.get(String(slot.key)) || [];
        const duration = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute));
        const elapsedMinutes = elapsedForSlot(detail.productionDate, slot, clock);
        const due = isDueSlot(detail.productionDate, slot, clock);
        const started = isStartedSlot(detail.productionDate, slot, clock);
        const isCurrent = currentSlotBase?.key === slot.key;
        const fraction = duration > 0 ? elapsedMinutes / duration : 0;
        const slotTarget = Number(value?.target || 0);
        const slotActual = entries.reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
        const slotActualAmount = entries.reduce((sum: number, entry: any) => sum + amountForEntry(entry, runById), 0);
        const slotTargetAmount = slotTarget * Number(run?.unitPriceSnapshot || 0);

        dayTarget += slotTarget;
        dayTargetAmount += slotTargetAmount;
        targetToNow += slotTarget * fraction;
        targetAmountToNow += slotTargetAmount * fraction;
        if (started) {
            actualToNow += slotActual;
            actualAmountToNow += slotActualAmount;
        }
        if (due) {
            checkpointTarget += slotTarget;
            checkpointActual += slotActual;
            checkpointTargetAmount += slotTargetAmount;
            checkpointActualAmount += slotActualAmount;
            if (value?.runId && !value?.reported) missingSlots.push(String(slot.key));
        }
        remainingActiveMinutes += Math.max(0, duration - elapsedMinutes);

        return {
            key: slot.key,
            label: slot.label,
            startMinute: Number(slot.startMinute),
            endMinute: Number(slot.endMinute),
            overtime: slot.kind === 'overtime',
            target: round(slotTarget),
            actual: slotActual,
            targetAmount: round(slotTargetAmount, 0),
            actualAmount: round(slotActualAmount, 0),
            achievementPercent: percent(slotActual, slotTarget),
            reported: Boolean(value?.reported),
            due,
            current: isCurrent,
            elapsedMinutes,
            remainingMinutes: Math.max(0, duration - elapsedMinutes),
            itemCode: run?.itemCode,
            itemName: run?.itemName,
            orderCode: run?.orderCode,
            state: !value?.runId
                ? 'not_planned'
                : due && !value.reported
                  ? 'missing'
                  : isCurrent
                    ? 'current'
                    : due
                      ? 'complete'
                      : 'upcoming',
        };
    });

    const currentSlotValue: any = currentSlotBase ? slotValueByKey.get(String(currentSlotBase.key)) : undefined;
    const contextualSlot =
        boardSlots.find((slot: any) => slot.current && slot.itemCode) ||
        [...boardSlots].reverse().find((slot: any) => slot.due && slot.itemCode) ||
        boardSlots.find((slot: any) => slot.itemCode);
    const contextualRunId = contextualSlot ? slotValueByKey.get(String(contextualSlot.key))?.runId : undefined;
    const currentRun: any = currentSlotValue?.runId
        ? runById.get(String(currentSlotValue.runId))
        : contextualRunId
          ? runById.get(String(contextualRunId))
          : undefined;
    const checkpointAchievement = percent(checkpointActual, checkpointTarget);
    const checkpointGap = round(checkpointActual - checkpointTarget);
    const missingLabels = missingSlots.map((key) => String(slotByKey.get(key)?.label || key));
    const status = statusForLine({
        configured: Boolean(line.configured),
        missingCount: missingSlots.length,
        checkpointTarget,
        achievement: checkpointAchievement,
    });

    let currentSlot;
    if (currentSlotBase && currentSlotValue?.runId) {
        const duration = Math.max(1, Number(currentSlotBase.endMinute) - Number(currentSlotBase.startMinute));
        const currentEntries = entriesBySlot.get(String(currentSlotBase.key)) || [];
        const currentActual = currentEntries.reduce((sum: number, entry: any) => sum + Number(entry.quantity || 0), 0);
        const carryShortfall = Math.max(0, -checkpointGap);
        const requiredQuantity = Math.max(0, Number(currentSlotValue.target || 0) + carryShortfall - currentActual);
        const elapsedMinutes = elapsedForSlot(detail.productionDate, currentSlotBase, clock);
        const remainingMinutes = Math.max(0, duration - elapsedMinutes);
        const rateMinutes = currentSlotValue.reported ? Math.max(1, remainingMinutes) : duration;
        currentSlot = {
            key: currentSlotBase.key,
            label: currentSlotBase.label,
            startMinute: Number(currentSlotBase.startMinute),
            endMinute: Number(currentSlotBase.endMinute),
            elapsedMinutes,
            remainingMinutes,
            target: round(Number(currentSlotValue.target || 0)),
            actual: currentActual,
            reported: Boolean(currentSlotValue.reported),
            carryShortfall,
            requiredQuantity: round(requiredQuantity),
            basePer15: round((Number(currentSlotValue.target || 0) / duration) * 15),
            requiredPer15: round((requiredQuantity / rateMinutes) * 15),
        };
    }

    const evaluationAvailable = checkpointTarget > 0 && checkpointTargetAmount > 0 && missingSlots.length === 0;
    const projectedQuantity = evaluationAvailable
        ? Math.max(actualToNow, (checkpointActual / checkpointTarget) * dayTarget)
        : undefined;
    const projectedAmount = evaluationAvailable
        ? Math.max(actualAmountToNow, (checkpointActualAmount / checkpointTargetAmount) * dayTargetAmount)
        : undefined;
    const workerCount = Number(line.workerCount || 0);
    const averageIncome = workerCount > 0 ? actualAmountToNow / workerCount : 0;
    const targetAverageIncome = workerCount > 0 ? dayTargetAmount / workerCount : 0;
    const projectedAverageIncome =
        workerCount > 0 && projectedAmount !== undefined ? projectedAmount / workerCount : undefined;
    const effectiveRemainingMinutes =
        currentSlot && !currentSlot.reported
            ? remainingActiveMinutes + currentSlot.elapsedMinutes
            : remainingActiveMinutes;
    const remainingQuantity = Math.max(0, dayTarget - actualToNow);
    const requiredPer15ForDay =
        effectiveRemainingMinutes > 0 ? (remainingQuantity / effectiveRemainingMinutes) * 15 : 0;

    const operationItems = (line.operationTrackSummaries || []).map((track: any) => {
        const values = (line.operationSlotValues || []).filter(
            (value: any) => String(value.trackId) === String(track.id)
        );
        const dueValues = values.filter((value: any) => {
            if (!value.due) return false;
            const slot = slotByKey.get(String(value.key));
            return slot ? isDueSlot(detail.productionDate, slot, clock) : false;
        });
        const missingValues = track.required ? dueValues.filter((value: any) => !value.reported) : [];
        const reportedValues = dueValues.filter((value: any) => value.reported);
        const behindValues = reportedValues.filter(
            (value: any) =>
                Number(value.target || 0) > 0 && percent(Number(value.actual || 0), Number(value.target || 0)) < 80
        );
        const critical = behindValues.some(
            (value: any) => percent(Number(value.actual || 0), Number(value.target || 0)) < 50
        );
        const currentValue = currentSlotBase
            ? values.find((value: any) => value.due && String(value.key) === String(currentSlotBase.key))
            : undefined;
        const target = dueValues.reduce((sum: number, value: any) => sum + Number(value.target || 0), 0);
        const actual = dueValues.reduce((sum: number, value: any) => sum + Number(value.actual || 0), 0);
        const status = missingValues.length
            ? 'missing'
            : critical
              ? 'critical'
              : behindValues.length
                ? 'at_risk'
                : dueValues.length && reportedValues.length
                  ? track.required
                      ? 'on_track'
                      : 'reference'
                  : dueValues.length
                    ? 'reference'
                    : 'waiting';
        return {
            trackId: track.id,
            operationCode: track.operationCode,
            operationName: track.operationName,
            itemCode: track.itemCode,
            unit: track.unit,
            required: Boolean(track.required),
            sortOrder: Number(track.sortOrder || 0),
            status,
            target: round(target),
            actual,
            achievementPercent: percent(actual, target),
            expectedEntries: track.required ? dueValues.length : 0,
            reportedEntries: track.required ? reportedValues.length : 0,
            missingCount: missingValues.length,
            behindCount: behindValues.length,
            currentSlot: currentValue
                ? {
                      key: currentValue.key,
                      target: Number(currentValue.target || 0),
                      actual: Number(currentValue.actual || 0),
                      reported: Boolean(currentValue.reported),
                  }
                : undefined,
        };
    });
    const operationExpectedEntries = operationItems.reduce(
        (sum: number, operation: any) => sum + Number(operation.expectedEntries || 0),
        0
    );
    const operationReportedEntries = operationItems.reduce(
        (sum: number, operation: any) => sum + Number(operation.reportedEntries || 0),
        0
    );

    const guidance = guidanceForLine({
        status,
        lineCode: line.lineCode,
        missingLabels,
        checkpointGap,
        currentSlot,
    });

    return {
        lineId: line.lineId,
        lineCode: line.lineCode,
        lineName: line.lineName,
        leaderName: line.leaderName,
        workerCount,
        configured: Boolean(line.configured),
        status,
        activeItem: currentRun
            ? {
                  runId: currentRun.id,
                  itemCode: currentRun.itemCode,
                  itemName: currentRun.itemName,
                  orderCode: currentRun.orderCode,
                  unitPrice: Number(currentRun.unitPriceSnapshot || 0),
                  hourlyQuota: Number(currentRun.hourlyQuota || 0),
              }
            : undefined,
        checkpoint: {
            target: round(checkpointTarget),
            actual: checkpointActual,
            gap: checkpointGap,
            achievementPercent: checkpointAchievement,
            targetAmount: round(checkpointTargetAmount, 0),
            actualAmount: round(checkpointActualAmount, 0),
            amountGap: round(checkpointActualAmount - checkpointTargetAmount, 0),
        },
        live: {
            targetToNow: round(targetToNow),
            actualToNow,
            gapToNow: round(actualToNow - targetToNow),
            targetAmountToNow: round(targetAmountToNow, 0),
            actualAmountToNow: round(actualAmountToNow, 0),
        },
        day: {
            target: round(dayTarget),
            actual: actualToNow,
            remaining: round(remainingQuantity),
            achievementPercent: percent(actualToNow, dayTarget),
            targetAmount: round(dayTargetAmount, 0),
            actualAmount: round(actualAmountToNow, 0),
            averageIncome: round(averageIncome, 0),
            targetAverageIncome: round(targetAverageIncome, 0),
            projectedQuantity: projectedQuantity === undefined ? undefined : round(projectedQuantity),
            projectedAmount: projectedAmount === undefined ? undefined : round(projectedAmount, 0),
            projectedAverageIncome: projectedAverageIncome === undefined ? undefined : round(projectedAverageIncome, 0),
            projectedIncomeGap:
                projectedAverageIncome === undefined
                    ? undefined
                    : round(projectedAverageIncome - targetAverageIncome, 0),
            requiredPer15: round(requiredPer15ForDay),
            overQuotaQuantity: round(Math.max(0, actualToNow - dayTarget)),
            overQuotaAmount: round(Math.max(0, actualAmountToNow - dayTargetAmount), 0),
        },
        currentSlot,
        operations: {
            trackedCount: operationItems.length,
            expectedEntries: operationExpectedEntries,
            reportedEntries: operationReportedEntries,
            missingCount: operationItems.reduce(
                (sum: number, operation: any) => sum + Number(operation.missingCount || 0),
                0
            ),
            behindCount: operationItems.filter((operation: any) => Number(operation.behindCount || 0) > 0).length,
            currentCount: operationItems.filter((operation: any) => operation.currentSlot).length,
            currentReportedCount: operationItems.filter((operation: any) => operation.currentSlot?.reported).length,
            items: operationItems,
        },
        guidance,
        missingSlots,
        slots: boardSlots,
        updatedAt: line.updatedAt || detail.updatedAt,
    };
};

export const buildProductionBoard = (detail: any, clock: ProductionBoardClock) => {
    const lines = detail.lines.map((line: any) => buildBoardLine(line, detail, clock));
    const currentSlot = detail.timeSlots.find(
        (slot: any) =>
            detail.productionDate === clock.localDate &&
            slot.isActive !== false &&
            clock.minuteOfDay >= Number(slot.startMinute) &&
            clock.minuteOfDay < Number(slot.endMinute)
    );
    const totalWorkers = lines.reduce((sum: number, line: any) => sum + line.workerCount, 0);
    const actualAmount = lines.reduce((sum: number, line: any) => sum + line.day.actualAmount, 0);
    const targetAmount = lines.reduce((sum: number, line: any) => sum + line.day.targetAmount, 0);
    const projectedLines = lines.filter((line: any) => line.day.projectedAmount !== undefined);
    const projectedAmount = projectedLines.length
        ? projectedLines.reduce((sum: number, line: any) => sum + Number(line.day.projectedAmount || 0), 0)
        : undefined;
    const target = lines.reduce((sum: number, line: any) => sum + line.day.target, 0);
    const actual = lines.reduce((sum: number, line: any) => sum + line.day.actual, 0);
    const checkpointTarget = lines.reduce((sum: number, line: any) => sum + line.checkpoint.target, 0);
    const checkpointActual = lines.reduce((sum: number, line: any) => sum + line.checkpoint.actual, 0);
    const operationExpectedEntries = lines.reduce(
        (sum: number, line: any) => sum + Number(line.operations.expectedEntries || 0),
        0
    );
    const operationReportedEntries = lines.reduce(
        (sum: number, line: any) => sum + Number(line.operations.reportedEntries || 0),
        0
    );

    return {
        asOf: clock.asOf,
        localDate: clock.localDate,
        productionDate: detail.productionDate,
        plantId: detail.plantId,
        plantName: detail.plantName,
        plantCode: detail.plantCode,
        dayStatus: detail.status,
        currentSlot: currentSlot
            ? {
                  key: currentSlot.key,
                  label: currentSlot.label,
                  startMinute: Number(currentSlot.startMinute),
                  endMinute: Number(currentSlot.endMinute),
                  remainingMinutes: Math.max(0, Number(currentSlot.endMinute) - clock.minuteOfDay),
              }
            : undefined,
        summary: {
            totalLines: lines.length,
            configuredLines: lines.filter((line: any) => line.configured).length,
            totalWorkers,
            checkpointTarget: round(checkpointTarget),
            checkpointActual,
            checkpointGap: round(checkpointActual - checkpointTarget),
            checkpointAchievementPercent: percent(checkpointActual, checkpointTarget),
            target,
            actual,
            achievementPercent: percent(actual, target),
            targetAmount: round(targetAmount, 0),
            actualAmount: round(actualAmount, 0),
            averageIncome: totalWorkers > 0 ? round(actualAmount / totalWorkers, 0) : 0,
            targetAverageIncome: totalWorkers > 0 ? round(targetAmount / totalWorkers, 0) : 0,
            projectedAmount: projectedAmount === undefined ? undefined : round(projectedAmount, 0),
            projectedAverageIncome:
                projectedAmount === undefined || totalWorkers <= 0
                    ? undefined
                    : round(projectedAmount / totalWorkers, 0),
            onTrackLines: lines.filter((line: any) => ['on_track', 'ahead'].includes(line.status)).length,
            attentionLines: lines.filter((line: any) => ['critical', 'at_risk'].includes(line.status)).length,
            missingLines: lines.filter((line: any) => line.status === 'missing').length,
            operationTrackedLines: lines.filter((line: any) => line.operations.trackedCount > 0).length,
            operationTrackCount: lines.reduce(
                (sum: number, line: any) => sum + Number(line.operations.trackedCount || 0),
                0
            ),
            operationExpectedEntries,
            operationReportedEntries,
            operationCoveragePercent: operationExpectedEntries
                ? round((operationReportedEntries / operationExpectedEntries) * 100)
                : 100,
            missingOperationEntries: lines.reduce(
                (sum: number, line: any) => sum + Number(line.operations.missingCount || 0),
                0
            ),
            behindOperations: lines.reduce(
                (sum: number, line: any) => sum + Number(line.operations.behindCount || 0),
                0
            ),
        },
        lines,
        updatedAt: detail.updatedAt,
    };
};
