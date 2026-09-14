export type PilotMetricKey =
    | 'actualOutput'
    | 'plannedOutput'
    | 'openOrders'
    | 'capacityUtilizationPercent'
    | 'materialBlockedOrders'
    | 'forecastLateOrders';

export type PilotMetrics = Record<PilotMetricKey, number>;

export type PilotThresholds = {
    minimumShadowDays: number;
    quantityVariancePercent: number;
    capacityVariancePoints: number;
    countVariance: number;
};

export type PilotDayInput = {
    date: string;
    systemSnapshot?: PilotMetrics;
    reference?: PilotMetrics;
    varianceAccepted?: boolean;
};

export type PilotChecklistInput = {
    mandatory: boolean;
    status: 'pending' | 'passed' | 'failed' | 'blocked' | 'not_applicable';
};

export type PilotLimitationInput = {
    severity: 'critical' | 'high' | 'medium' | 'low';
    status: 'open' | 'mitigated' | 'accepted' | 'resolved';
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const quantityMetrics = new Set<PilotMetricKey>(['actualOutput', 'plannedOutput']);
const countMetrics = new Set<PilotMetricKey>(['openOrders', 'materialBlockedOrders', 'forecastLateOrders']);

export const isPilotWorkingDate = (date: string) => new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 0;

export const countPilotWorkingDays = (startDate: string, endDate: string) => {
    const cursor = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    let count = 0;
    while (cursor <= end) {
        if (cursor.getUTCDay() !== 0) count += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
};

export const comparePilotMetric = (
    key: PilotMetricKey,
    systemValue: number,
    referenceValue: number,
    thresholds: PilotThresholds
) => {
    const difference = round(systemValue - referenceValue);
    const absoluteDifference = Math.abs(difference);
    const variancePercent = referenceValue
        ? round((absoluteDifference / Math.abs(referenceValue)) * 100)
        : systemValue
          ? 100
          : 0;
    const tolerance = quantityMetrics.has(key)
        ? thresholds.quantityVariancePercent
        : countMetrics.has(key)
          ? thresholds.countVariance
          : thresholds.capacityVariancePoints;
    const passed = quantityMetrics.has(key) ? variancePercent <= tolerance : absoluteDifference <= tolerance;
    return { key, systemValue, referenceValue, difference, variancePercent, tolerance, passed };
};

export const evaluatePilotDay = (day: PilotDayInput, thresholds: PilotThresholds) => {
    if (!day.systemSnapshot) return { status: 'pending_system' as const, comparisons: [], passed: false };
    if (!day.reference) return { status: 'pending_reference' as const, comparisons: [], passed: false };
    const keys: PilotMetricKey[] = [
        'actualOutput',
        'plannedOutput',
        'openOrders',
        'capacityUtilizationPercent',
        'materialBlockedOrders',
        'forecastLateOrders',
    ];
    const comparisons = keys.map((key) =>
        comparePilotMetric(key, Number(day.systemSnapshot![key] || 0), Number(day.reference![key] || 0), thresholds)
    );
    const matched = comparisons.every((row) => row.passed);
    if (matched) return { status: 'matched' as const, comparisons, passed: true };
    if (day.varianceAccepted) return { status: 'accepted_variance' as const, comparisons, passed: true };
    return { status: 'variance' as const, comparisons, passed: false };
};

export const summarizeProductionPilot = ({
    days,
    checklist,
    limitations,
    thresholds,
}: {
    days: PilotDayInput[];
    checklist: PilotChecklistInput[];
    limitations: PilotLimitationInput[];
    thresholds: PilotThresholds;
}) => {
    const workingDays = days.filter((day) => isPilotWorkingDate(day.date));
    const evaluatedDays = workingDays.map((day) => ({ ...evaluatePilotDay(day, thresholds), date: day.date }));
    const reconciledDays = evaluatedDays.filter((day) => ['matched', 'accepted_variance'].includes(day.status));
    const varianceDays = evaluatedDays.filter((day) => day.status === 'variance');
    const pendingDays = evaluatedDays.filter((day) => day.status.startsWith('pending'));
    const mandatoryChecklist = checklist.filter((item) => item.mandatory);
    const completedChecklist = mandatoryChecklist.filter((item) => ['passed', 'not_applicable'].includes(item.status));
    const failedChecklist = mandatoryChecklist.filter((item) => ['failed', 'blocked'].includes(item.status));
    const blockingLimitations = limitations.filter(
        (item) => ['critical', 'high'].includes(item.severity) && item.status === 'open'
    );
    const shadowDaysPassed = reconciledDays.length >= thresholds.minimumShadowDays;
    const checklistPassed =
        mandatoryChecklist.length > 0 &&
        completedChecklist.length === mandatoryChecklist.length &&
        !failedChecklist.length;
    const eligibleForSignoff =
        shadowDaysPassed && checklistPassed && !blockingLimitations.length && !varianceDays.length;
    return {
        capturedDays: workingDays.filter((day) => day.systemSnapshot).length,
        referenceDays: workingDays.filter((day) => day.reference).length,
        reconciledDays: reconciledDays.length,
        matchedDays: evaluatedDays.filter((day) => day.status === 'matched').length,
        acceptedVarianceDays: evaluatedDays.filter((day) => day.status === 'accepted_variance').length,
        varianceDays: varianceDays.length,
        pendingDays: pendingDays.length,
        minimumShadowDays: thresholds.minimumShadowDays,
        checklistTotal: mandatoryChecklist.length,
        checklistCompleted: completedChecklist.length,
        checklistFailed: failedChecklist.length,
        blockingLimitations: blockingLimitations.length,
        shadowDaysPassed,
        checklistPassed,
        eligibleForSignoff,
        evaluatedDays,
    };
};

export const DEFAULT_PRODUCTION_PILOT_CHECKLIST = [
    ['ORDER_HAPPY_PATH', 'business', 'Đơn chuẩn chạy từ nhập đơn đến hoàn thành'],
    ['MATERIAL_DELAY', 'business', 'Thiếu vật tư cập nhật đúng readiness và kế hoạch'],
    ['CAPACITY_DROP', 'business', 'Giảm năng lực đột xuất phản ánh đúng dự báo'],
    ['URGENT_FREEZE', 'business', 'Đơn khẩn trong vùng khóa có kiểm soát'],
    ['MULTI_LINE', 'business', 'Một mã phân bổ qua nhiều chuyền không trùng sản lượng'],
    ['UNDERPERFORMANCE', 'business', 'Chậm tiến độ liên tiếp sinh cảnh báo đúng'],
    ['REOPEN_AUDIT', 'data', 'Mở lại kế hoạch lưu đủ diff và lịch sử'],
    ['DIRTY_IMPORT', 'data', 'Import lớn có dòng trùng/sai bị chặn hoặc báo rõ'],
    ['ROLE_SCOPE', 'security', 'Phân quyền và phạm vi cơ sở đúng từng vai trò'],
    ['CONCURRENT_EDIT', 'reliability', 'Hai người sửa cùng lúc không ghi đè im lặng'],
    ['TIMEZONE', 'reliability', 'Ngày giờ Việt Nam đúng ở nhập liệu, báo cáo và dự báo'],
    ['BACKUP_RESTORE', 'rollback', 'Đã diễn tập backup, restore và xác minh dữ liệu'],
    ['ROLE_TRAINING', 'training', 'Người dùng pilot đã được hướng dẫn theo vai trò'],
    ['ROLLBACK_RUNBOOK', 'rollback', 'Đã duyệt runbook rollback và người chịu trách nhiệm'],
] as const;
