import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type {
    BriefingActionKey,
    BriefingComparison,
    BriefingContentItem,
    BriefingPeriodRange,
    BriefingPeriodType,
    ExecutiveBriefingContent,
    ExecutiveBriefingSnapshot,
} from '@/types/executiveBriefing';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

export const BRIEFING_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const pct = (value: number) => `${Math.round(value).toLocaleString('vi-VN')}%`;
const number = (value: number) => Math.round(value).toLocaleString('vi-VN');
const vnd = (value: number) => `${Math.round(value).toLocaleString('vi-VN')} đ`;

export const getClosedBriefingPeriod = (
    periodType: BriefingPeriodType,
    now: Date = new Date()
): BriefingPeriodRange => {
    const localNow = dayjs(now).tz(BRIEFING_TIME_ZONE);

    if (periodType === 'week') {
        const currentWeekStart = localNow.startOf('isoWeek');
        const rangeStart = currentWeekStart.subtract(1, 'week');
        const rangeEnd = currentWeekStart.subtract(1, 'millisecond');
        const comparisonStart = rangeStart.subtract(1, 'week');
        const comparisonEnd = rangeStart.subtract(1, 'millisecond');
        return {
            periodType,
            periodKey: `${rangeStart.isoWeekYear()}-W${String(rangeStart.isoWeek()).padStart(2, '0')}`,
            periodLabel: `Tuần ${rangeStart.format('DD/MM')}–${rangeEnd.format('DD/MM/YYYY')}`,
            rangeStart: rangeStart.toDate(),
            rangeEnd: rangeEnd.toDate(),
            comparisonKey: `${comparisonStart.isoWeekYear()}-W${String(comparisonStart.isoWeek()).padStart(2, '0')}`,
            comparisonLabel: `Tuần ${comparisonStart.format('DD/MM')}–${comparisonEnd.format('DD/MM/YYYY')}`,
            comparisonStart: comparisonStart.toDate(),
            comparisonEnd: comparisonEnd.toDate(),
        };
    }

    const currentMonthStart = localNow.startOf('month');
    const rangeStart = currentMonthStart.subtract(1, 'month');
    const rangeEnd = currentMonthStart.subtract(1, 'millisecond');
    const comparisonStart = rangeStart.subtract(1, 'month');
    const comparisonEnd = rangeStart.subtract(1, 'millisecond');
    return {
        periodType,
        periodKey: rangeStart.format('YYYY-MM'),
        periodLabel: `Tháng ${rangeStart.format('MM/YYYY')}`,
        rangeStart: rangeStart.toDate(),
        rangeEnd: rangeEnd.toDate(),
        comparisonKey: comparisonStart.format('YYYY-MM'),
        comparisonLabel: `Tháng ${comparisonStart.format('MM/YYYY')}`,
        comparisonStart: comparisonStart.toDate(),
        comparisonEnd: comparisonEnd.toDate(),
    };
};

export const compareValues = (current: number, previous: number): BriefingComparison => ({
    current,
    previous,
    delta: current - previous,
    deltaPct: previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : current === 0 ? 0 : null,
});

export const containsNumericClaim = (value: string) => /\d/.test(value);

export const actionUrlFor = (actionKey: BriefingActionKey) => {
    const urls: Record<BriefingActionKey, string> = {
        maintenance_overdue: '/maintenances?status=overdue',
        maintenance_list: '/maintenances',
        inventory_low_stock: '/materials/inventory?lowStock=true',
        purchase_requests: '/materials/purchase-requests',
        purchase_shortages: '/materials/purchase-orders?status=partially_received',
        supply_shortages: '/materials/distributions',
        transfer_backlog: '/transfers?status=pending',
        location_mismatch: '/assets/floor-map?reality=1',
        stocktake_anomaly: '/assets/stocktake',
        qr_gap: '/assets',
        facility_report: '/reports/facility-costs',
    };
    return urls[actionKey];
};

const item = (
    id: string,
    title: string,
    detail: string,
    severity: BriefingContentItem['severity'],
    evidenceKeys: string[],
    actionKey?: BriefingActionKey,
    actionLabel?: string
): BriefingContentItem => ({
    id,
    title,
    detail,
    severity,
    evidenceKeys,
    actionKey,
    actionLabel,
    actionUrl: actionKey ? actionUrlFor(actionKey) : undefined,
});

export const buildDeterministicBriefingContent = (
    snapshot: ExecutiveBriefingSnapshot,
    periodLabel: string
): ExecutiveBriefingContent => {
    const { fleet, maintenance, materials, operations } = snapshot;
    const summary = `${periodLabel} ghi nhận ${number(maintenance.completedTickets.current)} phiếu bảo trì hoàn tất và ${number(
        maintenance.newTickets.current
    )} phiếu mới. Tỷ lệ máy sẵn sàng tại thời điểm chốt dữ liệu đạt ${pct(fleet.availabilityPct)}. Giá trị đơn mua trong kỳ là ${vnd(
        materials.purchaseValue.current
    )}, trong khi giá trị vật tư đã cấp phát là ${vnd(materials.distributionValue.current)}; hai chỉ số được trình bày riêng để tránh ghi nhận trùng. Các tín hiệu cần rà soát gồm ${number(
        maintenance.overdueTickets
    )} phiếu bảo trì quá hạn, ${number(materials.lowStockCount)} dòng tồn thấp và ${number(
        operations.mislocatedAssets
    )} máy có dấu hiệu sai vị trí.`;

    const highlights: BriefingContentItem[] = [];
    if (fleet.availabilityPct >= 90) {
        highlights.push(
            item(
                'availability',
                'Tỷ lệ máy sẵn sàng duy trì ở mức tốt',
                `${number(fleet.activeMachines)}/${number(fleet.operationalMachines)} máy trong phạm vi vận hành đang hoạt động.`,
                'positive',
                ['fleet.availabilityPct']
            )
        );
    }
    if (maintenance.completedTickets.current > 0) {
        highlights.push(
            item(
                'maintenance-completed',
                'Hoàn tất xử lý bảo trì trong kỳ',
                `${number(maintenance.completedTickets.current)} phiếu đã hoàn tất, thời gian xử lý trung bình ${number(
                    maintenance.avgResolutionDays
                )} ngày.`,
                'positive',
                ['maintenance.completedTickets', 'maintenance.avgResolutionDays'],
                'maintenance_list',
                'Xem bảo trì'
            )
        );
    }
    if (operations.transfersCompleted.current > 0) {
        highlights.push(
            item(
                'transfer-completed',
                'Điều chuyển được hoàn tất',
                `${number(operations.transfersCompleted.current)} lệnh, tương ứng ${number(
                    operations.transferredAssets
                )} máy, đã hoàn tất trong kỳ.`,
                'info',
                ['operations.transfersCompleted'],
                'transfer_backlog',
                'Xem điều chuyển'
            )
        );
    }
    if (maintenance.externalRepairCost.deltaPct !== null && maintenance.externalRepairCost.deltaPct < 0) {
        highlights.push(
            item(
                'repair-cost-down',
                'Chi phí sửa ngoài giảm so với kỳ trước',
                `Giá trị ghi nhận trong kỳ là ${vnd(maintenance.externalRepairCost.current)}.`,
                'positive',
                ['maintenance.externalRepairCost'],
                'maintenance_list',
                'Xem chi phí sửa'
            )
        );
    }

    const risks: BriefingContentItem[] = [];
    if (fleet.availabilityPct < 85) {
        risks.push(
            item(
                'availability-low',
                'Tỷ lệ máy sẵn sàng cần được rà soát',
                `${number(fleet.activeMachines)}/${number(fleet.operationalMachines)} máy trong phạm vi vận hành đang hoạt động tại thời điểm chốt.`,
                fleet.availabilityPct < 75 ? 'critical' : 'warning',
                ['fleet.availabilityPct'],
                'facility_report',
                'Xem theo cơ sở'
            )
        );
    }
    if (fleet.qrCoveragePct < 90) {
        risks.push(
            item(
                'qr-coverage-gap',
                'Độ phủ tem QR chưa đạt yêu cầu',
                `${number(fleet.linkedQrAssets)}/${number(fleet.operationalMachines)} máy trong phạm vi vận hành có tem đang liên kết.`,
                fleet.qrCoveragePct < 70 ? 'critical' : 'warning',
                ['fleet.qrCoveragePct'],
                'qr_gap',
                'Rà soát tem QR'
            )
        );
    }
    if (maintenance.overdueTickets > 0) {
        risks.push(
            item(
                'maintenance-overdue',
                'Phiếu bảo trì tồn quá hạn',
                `${number(maintenance.overdueTickets)} phiếu mở trên 7 ngày cần được phân công và chốt thời hạn.`,
                maintenance.overdueTickets >= 5 ? 'critical' : 'warning',
                ['maintenance.overdueTickets'],
                'maintenance_overdue',
                'Xử lý phiếu quá hạn'
            )
        );
    }
    if (materials.lowStockCount > 0) {
        risks.push(
            item(
                'low-stock',
                'Vật tư bằng hoặc dưới định mức',
                `${number(materials.lowStockCount)} dòng tồn kho cần đối chiếu tồn thực tế và kế hoạch bổ sung.`,
                materials.lowStockCount >= 10 ? 'critical' : 'warning',
                ['materials.lowStockCount'],
                'inventory_low_stock',
                'Rà soát tồn kho'
            )
        );
    }
    if (materials.openPurchaseShortages > 0) {
        risks.push(
            item(
                'purchase-shortage',
                'Đơn mua còn hàng thiếu',
                `${number(materials.openPurchaseShortages)} dòng hàng vẫn đang chờ nhà cung cấp giao bù.`,
                'warning',
                ['materials.openPurchaseShortages'],
                'purchase_shortages',
                'Xem hàng thiếu'
            )
        );
    }
    if (operations.mislocatedAssets > 0) {
        risks.push(
            item(
                'mislocated-assets',
                'Máy có dấu hiệu sai vị trí',
                `${number(operations.mislocatedAssets)} máy có cơ sở quét gần nhất khác cơ sở quản lý.`,
                'warning',
                ['operations.mislocatedAssets'],
                'location_mismatch',
                'Đối chiếu vị trí'
            )
        );
    }
    if (operations.stocktakeAnomalies > 0 || operations.stocktakeMissing > 0) {
        risks.push(
            item(
                'stocktake-anomaly',
                'Kiểm kê phát sinh chênh lệch',
                `${number(operations.stocktakeMissing)} máy thiếu và ${number(
                    operations.stocktakeAnomalies
                )} bất thường được ghi nhận trong kỳ.`,
                operations.stocktakeMissing > 0 ? 'critical' : 'warning',
                ['operations.stocktakeAnomalies'],
                'stocktake_anomaly',
                'Mở kiểm kê'
            )
        );
    }

    const severityRank: Record<BriefingContentItem['severity'], number> = {
        critical: 0,
        warning: 1,
        info: 2,
        positive: 3,
    };
    const prioritizedRisks = risks.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]).slice(0, 5);
    const actionTitles: Partial<Record<BriefingActionKey, string>> = {
        maintenance_overdue: 'Chốt người phụ trách các phiếu quá hạn',
        inventory_low_stock: 'Xác nhận tồn thực tế và nhu cầu bổ sung',
        purchase_shortages: 'Làm rõ lịch giao bù với nhà cung cấp',
        location_mismatch: 'Đối chiếu QR và lịch sử điều chuyển',
        stocktake_anomaly: 'Xác minh chênh lệch kiểm kê',
        qr_gap: 'Lập danh sách máy chưa liên kết tem QR',
        facility_report: 'Rà soát nguyên nhân theo từng cơ sở',
    };
    const actions: BriefingContentItem[] = prioritizedRisks.slice(0, 4).map((risk, index) => ({
        ...risk,
        id: `action-${risk.id}`,
        severity: index === 0 && risk.severity === 'critical' ? 'critical' : 'warning',
        title: (risk.actionKey && actionTitles[risk.actionKey]) || 'Xác minh tín hiệu vận hành',
    }));

    if (!actions.length) {
        actions.push(
            item(
                'action-review-stable',
                'Duy trì rà soát theo cơ sở',
                'Không có cảnh báo ưu tiên cao; tiếp tục theo dõi các chỉ số vận hành theo lịch tuần.',
                'info',
                ['fleet.availabilityPct'],
                'facility_report',
                'Xem báo cáo cơ sở'
            )
        );
    }

    return {
        summary,
        highlights: highlights.slice(0, 4),
        risks: prioritizedRisks,
        actions: actions.slice(0, 4),
    };
};
