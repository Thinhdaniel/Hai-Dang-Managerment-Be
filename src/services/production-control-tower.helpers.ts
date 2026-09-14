import { addCapacityDays } from './production-capacity.helpers';

export type ControlTowerSeverity = 'critical' | 'warning' | 'info';
export type ControlTowerForecastConfidence = 'high' | 'medium' | 'low' | 'none';
export type ControlTowerForecastStatus = 'completed' | 'on_track' | 'at_risk' | 'late' | 'no_forecast';
export type ControlTowerExceptionCode =
    | 'overdue'
    | 'forecast_late'
    | 'no_forecast'
    | 'material_shortage'
    | 'material_not_reserved'
    | 'material_unknown'
    | 'unplanned_quantity'
    | 'draft_plan'
    | 'behind_plan'
    | 'no_recent_output'
    | 'status_mismatch';

export type ControlTowerException = {
    code: ControlTowerExceptionCode;
    severity: ControlTowerSeverity;
    title: string;
    description: string;
    action: 'materials' | 'master_plan' | 'planning' | 'monitor' | 'sync_status' | 'order';
};

type DailyQuantity = { date: string; quantity: number };
type PlanQuantity = { date: string; quantity: number; status: 'draft' | 'published' };

export type BuildControlTowerOrderInput = {
    order: {
        id: string;
        code: string;
        itemId: string;
        itemCode: string;
        itemName?: string;
        customerName?: string;
        totalQuantity: number;
        dueDate: string;
        plannedStartDate?: string;
        priority: string;
        status: string;
    };
    progress: {
        producedQuantity: number;
        remainingQuantity: number;
        completionPercent: number;
        futurePlannedQuantity: number;
        unplannedQuantity: number;
        lastProductionDate?: string;
        activeLineCodes?: string[];
    };
    material?: {
        status: 'ready' | 'partial' | 'shortage' | 'unknown';
        reservationStatus: 'reserved' | 'partial' | 'unreserved' | 'not_configured';
        shortageLineCount?: number;
        materialReadyDate?: string;
    };
    dailyActual: DailyQuantity[];
    plans: PlanQuantity[];
    today: string;
};

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const dayDistance = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
const isWorkingDate = (date: string) => new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 0;
const nextWorkingDate = (date: string) => {
    let next = addCapacityDays(date, 1);
    while (!isWorkingDate(next)) next = addCapacityDays(next, 1);
    return next;
};
const severityRank: Record<ControlTowerSeverity, number> = { critical: 0, warning: 1, info: 2 };

export const resolveProductionOrderLifecycleStatus = ({
    currentStatus,
    producedQuantity,
    totalQuantity,
    futurePlannedQuantity,
}: {
    currentStatus: string;
    producedQuantity: number;
    totalQuantity: number;
    futurePlannedQuantity: number;
}) => {
    if (currentStatus === 'cancelled') return currentStatus;
    if (producedQuantity >= totalQuantity && totalQuantity > 0) return 'completed';
    if (currentStatus === 'completed' && producedQuantity < totalQuantity) return 'in_production';
    if (currentStatus === 'paused') return currentStatus;
    if (producedQuantity > 0 && ['draft', 'ready'].includes(currentStatus)) return 'in_production';
    if (futurePlannedQuantity > 0 && currentStatus === 'draft') return 'ready';
    return currentStatus;
};

export const buildControlTowerOrder = (input: BuildControlTowerOrderInput) => {
    const { order, progress, material, today } = input;
    const actualByDate = new Map(input.dailyActual.map((row) => [row.date, Number(row.quantity || 0)]));
    const recentSamples = [...input.dailyActual]
        .filter((row) => row.date <= today)
        .sort((left, right) => right.date.localeCompare(left.date))
        .slice(0, 5);
    const positiveSamples = recentSamples.filter((row) => row.quantity > 0);
    const recentDailyRate = positiveSamples.length
        ? round(positiveSamples.reduce((sum, row) => sum + row.quantity, 0) / positiveSamples.length)
        : 0;

    const publishedPlans = input.plans
        .filter((row) => row.status === 'published')
        .sort((left, right) => left.date.localeCompare(right.date));
    const futurePublishedPlans = publishedPlans.filter((row) => row.date >= today);
    const futureDraftPlans = input.plans.filter((row) => row.status === 'draft' && row.date >= today);
    const scheduledQuantity = futurePublishedPlans.reduce((sum, row) => {
        const actualToday = row.date === today ? Number(actualByDate.get(today) || 0) : 0;
        return sum + Math.max(0, row.quantity - actualToday);
    }, 0);
    const draftQuantity = futureDraftPlans.reduce((sum, row) => sum + row.quantity, 0);
    const planCoveragePercent =
        progress.remainingQuantity > 0
            ? round(Math.min(100, (scheduledQuantity / progress.remainingQuantity) * 100))
            : 100;

    const historicalPlan = publishedPlans.filter((row) => row.date < today).slice(-7);
    const historicalPlannedQuantity = historicalPlan.reduce((sum, row) => sum + row.quantity, 0);
    const historicalActualQuantity = historicalPlan.reduce(
        (sum, row) => sum + Number(actualByDate.get(row.date) || 0),
        0
    );
    const recentPerformancePercent = historicalPlannedQuantity
        ? round((historicalActualQuantity / historicalPlannedQuantity) * 100)
        : undefined;

    let forecastDate: string | undefined;
    let uncovered = Math.max(0, progress.remainingQuantity);
    let lastForecastDate = today;
    if (uncovered <= 0) {
        forecastDate = progress.lastProductionDate || today;
    } else {
        for (const plan of futurePublishedPlans) {
            const actualToday = plan.date === today ? Number(actualByDate.get(today) || 0) : 0;
            uncovered = Math.max(0, uncovered - Math.max(0, plan.quantity - actualToday));
            lastForecastDate = plan.date;
            if (uncovered <= 0) {
                forecastDate = plan.date;
                break;
            }
        }
        if (!forecastDate && recentDailyRate > 0) {
            let cursor = lastForecastDate;
            let guard = 0;
            while (uncovered > 0 && guard < 366) {
                cursor =
                    cursor === today && isWorkingDate(today) && !futurePublishedPlans.length
                        ? today
                        : nextWorkingDate(cursor);
                uncovered = Math.max(0, uncovered - recentDailyRate);
                forecastDate = cursor;
                guard += 1;
            }
        }
    }

    const forecastConfidence: ControlTowerForecastConfidence =
        progress.remainingQuantity <= 0
            ? 'high'
            : positiveSamples.length >= 3
              ? 'high'
              : positiveSamples.length || scheduledQuantity >= progress.remainingQuantity
                ? 'medium'
                : scheduledQuantity > 0
                  ? 'low'
                  : 'none';
    const forecastVarianceDays = forecastDate ? dayDistance(order.dueDate, forecastDate) : undefined;
    const dueInDays = dayDistance(today, order.dueDate);
    const forecastStatus: ControlTowerForecastStatus =
        progress.remainingQuantity <= 0
            ? 'completed'
            : !forecastDate
              ? 'no_forecast'
              : forecastDate > order.dueDate || dueInDays < 0
                ? 'late'
                : forecastDate === order.dueDate || dueInDays <= 2 || planCoveragePercent < 100
                  ? 'at_risk'
                  : 'on_track';

    const expectedStatus = resolveProductionOrderLifecycleStatus({
        currentStatus: order.status,
        producedQuantity: progress.producedQuantity,
        totalQuantity: order.totalQuantity,
        futurePlannedQuantity: progress.futurePlannedQuantity,
    });
    const exceptions: ControlTowerException[] = [];
    const add = (exception: ControlTowerException) => exceptions.push(exception);

    if (progress.remainingQuantity > 0 && dueInDays < 0) {
        add({
            code: 'overdue',
            severity: 'critical',
            title: `Quá hạn ${Math.abs(dueInDays)} ngày`,
            description: `Còn ${Math.ceil(progress.remainingQuantity).toLocaleString('vi-VN')} SP chưa hoàn thành.`,
            action: 'master_plan',
        });
    } else if (forecastStatus === 'late' && forecastVarianceDays !== undefined) {
        add({
            code: 'forecast_late',
            severity: forecastVarianceDays > 2 ? 'critical' : 'warning',
            title: `Dự báo trễ ${forecastVarianceDays} ngày`,
            description: `Ngày hoàn thành dự kiến ${forecastDate}, hạn giao ${order.dueDate}.`,
            action: 'master_plan',
        });
    }
    if (progress.remainingQuantity > 0 && !forecastDate) {
        add({
            code: 'no_forecast',
            severity: 'warning',
            title: 'Chưa thể dự báo ngày hoàn thành',
            description: 'Đơn chưa có đủ lịch đã ban hành hoặc tốc độ thực tế để ngoại suy.',
            action: 'planning',
        });
    }
    if (progress.remainingQuantity > 0 && (material?.status === 'shortage' || material?.status === 'partial')) {
        add({
            code: 'material_shortage',
            severity: 'critical',
            title: `Thiếu ${material.shortageLineCount || 1} dòng vật tư`,
            description: 'Nguồn tồn và lượng về đã xác nhận chưa đủ cho nhu cầu đơn hàng.',
            action: 'materials',
        });
    } else if (
        progress.remainingQuantity > 0 &&
        material?.status === 'ready' &&
        material.reservationStatus !== 'reserved'
    ) {
        add({
            code: 'material_not_reserved',
            severity: 'warning',
            title: 'Vật tư đủ nhưng chưa giữ tồn',
            description: 'Tồn khả dụng có thể bị đơn khác sử dụng trước.',
            action: 'materials',
        });
    } else if (progress.remainingQuantity > 0 && (!material || material.status === 'unknown')) {
        add({
            code: 'material_unknown',
            severity: 'info',
            title: 'Chưa có BOM được phê duyệt',
            description: 'Chưa thể xác nhận mức sẵn sàng nguyên phụ liệu.',
            action: 'materials',
        });
    }
    if (progress.unplannedQuantity > 0) {
        add({
            code: 'unplanned_quantity',
            severity: dueInDays <= 3 ? 'critical' : 'warning',
            title: `${Math.ceil(progress.unplannedQuantity).toLocaleString('vi-VN')} SP chưa xếp lịch`,
            description: `Kế hoạch đã ban hành mới phủ ${planCoveragePercent}% phần còn lại.`,
            action: 'master_plan',
        });
    }
    if (draftQuantity > 0) {
        add({
            code: 'draft_plan',
            severity: 'info',
            title: `${Math.ceil(draftQuantity).toLocaleString('vi-VN')} SP còn ở kế hoạch nháp`,
            description: 'Sản lượng nháp chưa được tính là cam kết sản xuất.',
            action: 'planning',
        });
    }
    if (recentPerformancePercent !== undefined && recentPerformancePercent < 80) {
        add({
            code: 'behind_plan',
            severity: recentPerformancePercent < 60 ? 'critical' : 'warning',
            title: `Nhịp gần đây chỉ đạt ${recentPerformancePercent}%`,
            description: `Thực tế ${historicalActualQuantity.toLocaleString('vi-VN')}/${historicalPlannedQuantity.toLocaleString('vi-VN')} SP theo lịch đã ban hành.`,
            action: 'monitor',
        });
    }
    if (
        order.status === 'in_production' &&
        (!progress.lastProductionDate || dayDistance(progress.lastProductionDate, today) >= 2)
    ) {
        add({
            code: 'no_recent_output',
            severity: 'warning',
            title: 'Không có sản lượng mới trong 2 ngày',
            description: 'Cần kiểm tra chuyền đang chạy, dữ liệu nhập hoặc trạng thái tạm dừng.',
            action: 'monitor',
        });
    }
    if (expectedStatus !== order.status) {
        add({
            code: 'status_mismatch',
            severity: 'info',
            title: 'Trạng thái chưa khớp số thực tế',
            description: `Hệ thống đề xuất chuyển từ ${order.status} sang ${expectedStatus}.`,
            action: 'sync_status',
        });
    }
    exceptions.sort(
        (left, right) =>
            severityRank[left.severity] - severityRank[right.severity] || left.code.localeCompare(right.code)
    );

    return {
        ...order,
        progress,
        material: material || {
            status: 'unknown',
            reservationStatus: 'not_configured',
            shortageLineCount: 0,
        },
        recentDailyRate,
        recentSampleCount: positiveSamples.length,
        recentPerformancePercent,
        scheduledQuantity: round(scheduledQuantity),
        draftQuantity: round(draftQuantity),
        planCoveragePercent,
        forecastDate,
        forecastVarianceDays,
        forecastConfidence,
        forecastStatus,
        expectedStatus,
        dailyActual: [...input.dailyActual].sort((left, right) => left.date.localeCompare(right.date)),
        plans: [...input.plans].sort((left, right) => left.date.localeCompare(right.date)),
        exceptions,
        severity: exceptions.some((row) => row.severity === 'critical')
            ? 'critical'
            : exceptions.some((row) => row.severity === 'warning')
              ? 'warning'
              : 'normal',
    };
};

export const summarizeControlTower = (orders: Array<ReturnType<typeof buildControlTowerOrder>>, today: string) => ({
    totalOrders: orders.length,
    openOrders: orders.filter((order) => !['completed', 'cancelled'].includes(order.status)).length,
    criticalOrders: orders.filter((order) => order.severity === 'critical').length,
    warningOrders: orders.filter((order) => order.severity === 'warning').length,
    forecastLateOrders: orders.filter((order) => order.forecastStatus === 'late').length,
    materialBlockedOrders: orders.filter((order) => ['partial', 'shortage'].includes(order.material.status)).length,
    statusMismatchOrders: orders.filter((order) => order.expectedStatus !== order.status).length,
    remainingQuantity: orders.reduce((sum, order) => sum + order.progress.remainingQuantity, 0),
    unplannedQuantity: orders.reduce((sum, order) => sum + order.progress.unplannedQuantity, 0),
    actualToday: orders.reduce(
        (sum, order) => sum + Number(order.dailyActual.find((row) => row.date === today)?.quantity || 0),
        0
    ),
    planCoveragePercent: orders.reduce((sum, order) => sum + order.progress.remainingQuantity, 0)
        ? round(
              (orders.reduce(
                  (sum, order) => sum + Math.min(order.scheduledQuantity, order.progress.remainingQuantity),
                  0
              ) /
                  orders.reduce((sum, order) => sum + order.progress.remainingQuantity, 0)) *
                  100
          )
        : 100,
});
