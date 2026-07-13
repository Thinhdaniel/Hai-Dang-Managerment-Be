import { createHash } from 'node:crypto';

export type DigestValidationIssue = {
    code: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    detail?: string;
    actionUrl?: string;
    refType?: string;
    refId?: string;
};

type DigestLike = Record<string, any>;

export const digestMaterialKey = (item: any) =>
    `${String(item?.materialId || item?.materialCode || item?.materialName || '')}:${String(item?.plantId || item?.plantName || '')}`;

const uniqueStrings = (values: unknown) =>
    Array.from(
        new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))
    );

export const normalizeDigestEditorial = (editorial?: Record<string, any> | null) => ({
    hiddenIncidentIds: uniqueStrings(editorial?.hiddenIncidentIds),
    hiddenRepairIds: uniqueStrings(editorial?.hiddenRepairIds),
    hiddenMaterialKeys: uniqueStrings(editorial?.hiddenMaterialKeys),
    hiddenPlantIds: uniqueStrings(editorial?.hiddenPlantIds),
});

export const applyDigestEditorial = (
    snapshot: Record<string, any> = {},
    editorial?: Record<string, any> | null
): Record<string, any> => {
    const normalized = normalizeDigestEditorial(editorial);
    const hiddenIncidents = new Set(normalized.hiddenIncidentIds);
    const hiddenRepairs = new Set(normalized.hiddenRepairIds);
    const hiddenMaterials = new Set(normalized.hiddenMaterialKeys);
    const hiddenPlants = new Set(normalized.hiddenPlantIds);

    return {
        ...snapshot,
        notableIncidents: (snapshot.notableIncidents || []).filter(
            (item: any) => !hiddenIncidents.has(String(item.id))
        ),
        successfulRepairs: (snapshot.successfulRepairs || []).filter(
            (item: any) => !hiddenRepairs.has(String(item.id))
        ),
        inventory: {
            ...(snapshot.inventory || {}),
            lowStock: (snapshot.inventory?.lowStock || []).filter(
                (item: any) => !hiddenMaterials.has(digestMaterialKey(item))
            ),
        },
        plantPerformance: (snapshot.plantPerformance || []).filter(
            (item: any) => !hiddenPlants.has(String(item.plantId || item.plantName || ''))
        ),
    };
};

export const getDigestImmutablePayload = (digest: DigestLike) => ({
    periodType: digest.periodType,
    periodKey: digest.periodKey,
    periodLabel: digest.periodLabel,
    rangeStart: digest.rangeStart,
    rangeEnd: digest.rangeEnd,
    version: Number(digest.version || 1),
    contentRevision: Number(digest.contentRevision || 0),
    snapshot: digest.snapshot || {},
    narrative: digest.narrative || '',
    highlights: digest.highlights || [],
    alerts: digest.alerts || [],
    recommendations: digest.recommendations || [],
    dataWarnings: digest.dataWarnings || [],
    editorial: normalizeDigestEditorial(digest.editorial),
    visual: {
        status: digest.visual?.status,
        coverImageUrl: digest.visual?.coverImageUrl,
        aiGenerated: Boolean(digest.visual?.aiGenerated),
    },
});

export const getDigestChecksum = (digest: DigestLike) =>
    createHash('sha256')
        .update(JSON.stringify(getDigestImmutablePayload(digest)))
        .digest('hex');

const finiteNonNegative = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0;

export const validateDigestDocument = (digest: DigestLike) => {
    const issues: DigestValidationIssue[] = [];
    const snapshot = digest.snapshot || {};
    const editorial = normalizeDigestEditorial(digest.editorial);
    const visible = applyDigestEditorial(snapshot, editorial);
    const add = (issue: DigestValidationIssue) => issues.push(issue);

    if (!digest.periodKey || !digest.rangeStart || !digest.rangeEnd) {
        add({
            code: 'period_missing',
            severity: 'critical',
            title: 'Thiếu phạm vi kỳ báo cáo',
            detail: 'Bản tin không có đủ mã kỳ hoặc ngày bắt đầu/kết thúc.',
        });
    }

    if (String(digest.narrative || '').trim().length < 80) {
        add({
            code: 'narrative_too_short',
            severity: 'critical',
            title: 'Tóm tắt điều hành chưa đạt',
            detail: 'Nội dung tóm tắt cần ít nhất 80 ký tự trước khi phê duyệt.',
        });
    }

    if (!snapshot.machines || !finiteNonNegative(snapshot.machines.total)) {
        add({
            code: 'machine_snapshot_missing',
            severity: 'critical',
            title: 'Thiếu snapshot máy',
            detail: 'Không xác định được tổng số máy trong kỳ báo cáo.',
            actionUrl: '/assets',
            refType: 'asset',
        });
    } else {
        const machineValues = [
            snapshot.machines.total,
            snapshot.machines.active,
            snapshot.machines.maintenance,
            snapshot.machines.inactive,
        ];
        if (!machineValues.every(finiteNonNegative)) {
            add({
                code: 'machine_metrics_invalid',
                severity: 'critical',
                title: 'Chỉ số máy không hợp lệ',
                detail: 'Có chỉ số máy bị âm hoặc không phải số.',
                actionUrl: '/assets',
                refType: 'asset',
            });
        }
    }

    if (!Array.isArray(digest.highlights) || digest.highlights.length === 0) {
        add({
            code: 'highlights_empty',
            severity: 'warning',
            title: 'Chưa có điểm nổi bật',
            detail: 'Nên bổ sung ít nhất một kết quả đáng chú ý của kỳ.',
        });
    }
    if (!Array.isArray(digest.recommendations) || digest.recommendations.length === 0) {
        add({
            code: 'recommendations_empty',
            severity: 'warning',
            title: 'Chưa có hành động đề xuất',
            detail: 'Bản tin điều hành nên có ít nhất một hành động tiếp theo.',
        });
    }

    if (Number(snapshot.maintenance?.overdueCount || 0) > 0) {
        add({
            code: 'maintenance_overdue',
            severity: 'warning',
            title: `${snapshot.maintenance.overdueCount} phiếu bảo trì quá hạn`,
            detail: 'Cần xác nhận người phụ trách và thời hạn xử lý trước khi phát hành.',
            actionUrl: '/maintenances?status=overdue',
            refType: 'maintenance',
        });
    }

    if (Number(snapshot.inventory?.lowStockCount || 0) > 0) {
        add({
            code: 'inventory_low_stock',
            severity: 'warning',
            title: `${snapshot.inventory.lowStockCount} dòng vật tư dưới định mức`,
            detail: 'Đối chiếu tồn thực tế và kế hoạch mua/cấp bù.',
            actionUrl: '/materials/inventory?stock=low',
            refType: 'material',
        });
    }

    if (Number(snapshot.gps?.mislocatedCount || 0) > 0) {
        add({
            code: 'asset_location_mismatch',
            severity: 'warning',
            title: `${snapshot.gps.mislocatedCount} máy lệch vị trí`,
            detail: 'Cần đối chiếu lịch sử QR và điều chuyển.',
            actionUrl: '/assets/floor-map?reality=1',
            refType: 'asset',
        });
    }

    const completed = Number(snapshot.evidence?.completedRepairsCount || 0);
    const evidenceCoverage = Number(snapshot.evidence?.coveragePct || 0);
    if (completed > 0 && evidenceCoverage < 50) {
        add({
            code: 'repair_evidence_low',
            severity: 'warning',
            title: 'Ảnh trước/sau chưa đại diện',
            detail: `Chỉ ${evidenceCoverage}% ca sửa hoàn tất có đủ ảnh trước và sau.`,
            actionUrl: '/maintenances?status=completed',
            refType: 'maintenance',
        });
    }

    if (digest.visual?.status === 'failed') {
        add({
            code: 'cover_generation_failed',
            severity: 'warning',
            title: 'Tạo ảnh bìa AI thất bại',
            detail: digest.visual.error || 'Hãy chọn ảnh thủ công hoặc tạo lại.',
        });
    } else if (digest.visual?.status === 'fallback' && digest.visual?.error) {
        add({
            code: 'cover_generation_fallback',
            severity: 'warning',
            title: 'Ảnh bìa AI đã dùng phương án dự phòng',
            detail: 'Hệ thống đang dùng ảnh hiện trường vì lần tạo ảnh AI không thành công.',
        });
    } else if (!digest.visual?.coverImageUrl) {
        add({
            code: 'cover_missing',
            severity: 'info',
            title: 'Đang dùng bìa hệ thống',
            detail: 'Có thể chọn ảnh hiện trường hoặc tạo ảnh bìa AI trước khi phát hành.',
        });
    }

    const sourceWarnings = digest.dataWarnings?.length ? digest.dataWarnings : snapshot.dataWarnings || [];
    for (const warning of sourceWarnings) {
        add({
            code: `data_warning_${issues.length + 1}`,
            severity: 'warning',
            title: 'Giới hạn dữ liệu nguồn',
            detail: String(warning),
        });
    }

    const hiddenCount =
        editorial.hiddenIncidentIds.length +
        editorial.hiddenRepairIds.length +
        editorial.hiddenMaterialKeys.length +
        editorial.hiddenPlantIds.length;
    if (hiddenCount > 0) {
        add({
            code: 'editorial_items_hidden',
            severity: 'info',
            title: `${hiddenCount} mục đã được ẩn khỏi bản phát hành`,
            detail: 'Các số KPI tổng vẫn giữ nguyên theo snapshot; chỉ danh sách chi tiết được biên tập.',
        });
    }

    if ((snapshot.notableIncidents || []).length > 0 && visible.notableIncidents.length === 0) {
        add({
            code: 'all_incidents_hidden',
            severity: 'warning',
            title: 'Đã ẩn toàn bộ sự cố nổi bật',
            detail: 'Kiểm tra lại lựa chọn biên tập để tránh bản tin thiếu bối cảnh vận hành.',
        });
    }
    if ((snapshot.inventory?.lowStock || []).length > 0 && visible.inventory?.lowStock?.length === 0) {
        add({
            code: 'all_low_stock_hidden',
            severity: 'warning',
            title: 'Đã ẩn toàn bộ vật tư dưới định mức',
            detail: 'KPI thiếu vật tư vẫn hiển thị nhưng bản phát hành sẽ không còn danh sách đối chiếu.',
        });
    }
    if ((snapshot.successfulRepairs || []).length > 0 && visible.successfulRepairs.length === 0) {
        add({
            code: 'all_repairs_hidden',
            severity: 'warning',
            title: 'Đã ẩn toàn bộ ca sửa hoàn tất',
            detail: 'Kiểm tra lại lựa chọn nếu bản tin cần thể hiện kết quả bảo trì trong kỳ.',
        });
    }
    if ((snapshot.plantPerformance || []).length > 0 && visible.plantPerformance.length === 0) {
        add({
            code: 'all_plants_hidden',
            severity: 'warning',
            title: 'Đã ẩn toàn bộ phần hiệu quả cơ sở',
            detail: 'Bản phát hành sẽ không còn phần so sánh vận hành giữa các cơ sở.',
        });
    }

    const hasCritical = issues.some((issue) => issue.severity === 'critical');
    const hasWarning = issues.some((issue) => issue.severity === 'warning');
    return {
        status: hasCritical ? ('blocked' as const) : hasWarning ? ('warning' as const) : ('passed' as const),
        issues: issues.slice(0, 30),
        checkedAt: new Date(),
        checksum: getDigestChecksum(digest),
    };
};
