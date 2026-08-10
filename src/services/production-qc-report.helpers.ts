type QcReportFilters = {
    itemId?: string;
    lineId?: string;
    orderCode?: string;
};

type QcReportOptions = {
    plantId: string;
    plantName?: string;
    plantCode?: string;
    from: string;
    to: string;
    generatedAt?: string;
    trackingStartDate?: string;
    filters?: QcReportFilters;
    productionOpening: { coverage: any; entries: any[] };
    qcOpening: { coverage: any; entries: any[] };
    lineRecords: any[];
    qcRecords: any[];
};

type ProductionEvent = {
    date?: string;
    lineId: string;
    lineCode: string;
    lineName?: string;
    itemId?: string;
    itemCode?: string;
    itemName?: string;
    orderCode?: string;
    quantity: number;
    opening: boolean;
};

type QcEvent = {
    date?: string;
    lineId: string;
    lineCode: string;
    lineName?: string;
    itemId?: string;
    itemCode?: string;
    itemName?: string;
    orderCode?: string;
    inspectionType: 'first_pass' | 'recheck';
    passedQuantity: number;
    defectQuantity: number;
    totalQuantity: number;
    allocated: boolean;
    legacy: boolean;
};

const UNALLOCATED = '__unallocated__';
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const id = (value: any) => String(value?._id ?? value?.id ?? value ?? '');
const order = (value: unknown) =>
    String(value || '')
        .trim()
        .toUpperCase();
const percent = (numerator: number, denominator: number) =>
    denominator > 0 ? round((numerator / denominator) * 100, 2) : 0;

const matches = (event: { itemId?: string; lineId: string; orderCode?: string }, filters: QcReportFilters) => {
    if (filters.itemId && String(event.itemId || '') !== filters.itemId) return false;
    if (filters.lineId && event.lineId !== filters.lineId) return false;
    if (filters.orderCode && order(event.orderCode) !== order(filters.orderCode)) return false;
    return true;
};

const normalizeProductionEvents = (options: QcReportOptions): ProductionEvent[] => {
    const opening = (options.productionOpening.entries || []).map((entry: any) => ({
        lineId: id(entry.lineId),
        lineCode: String(entry.lineCode || 'Chưa phân bổ'),
        lineName: entry.lineName,
        itemId: id(entry.itemId) || undefined,
        itemCode: entry.itemCode,
        itemName: entry.itemName,
        orderCode: entry.orderCode,
        quantity: Number(entry.quantity || 0),
        opening: true,
    }));
    const tracked = options.lineRecords.flatMap((record: any) => {
        const runById = new Map((record.runs || []).map((run: any) => [id(run), run]));
        return (record.entries || []).map((entry: any) => {
            const run: any = runById.get(id(entry.runId));
            return {
                date: record.productionDate,
                lineId: id(record.lineId),
                lineCode: String(record.lineCode || ''),
                lineName: record.lineName,
                itemId: id(run?.itemId) || undefined,
                itemCode: run?.itemCode,
                itemName: run?.itemName,
                orderCode: run?.orderCode,
                quantity: Number(entry.quantity || 0),
                opening: false,
            };
        });
    });
    return [...opening, ...tracked].filter((event) => matches(event, options.filters || {}));
};

const normalizeQcEvents = (options: QcReportOptions, filters = options.filters || {}): QcEvent[] => {
    const structuredSlots = new Set(
        options.qcRecords.map((record: any) => `${id(record.dayId)}|${id(record.lineId)}|${record.slotKey}`)
    );
    const structured: QcEvent[] = options.qcRecords.flatMap((record: any) =>
        (record.inspections || []).map((entry: any) => {
            const passedQuantity = Number(entry.passedQuantity || 0);
            const defectQuantity = Number(entry.defectQuantity || 0);
            return {
                date: record.productionDate,
                lineId: id(record.lineId),
                lineCode: String(record.lineCode || ''),
                lineName: record.lineName,
                itemId: id(entry.itemId) || undefined,
                itemCode: entry.itemCode,
                itemName: entry.itemName,
                orderCode: entry.orderCode,
                inspectionType: entry.inspectionType === 'recheck' ? 'recheck' : 'first_pass',
                passedQuantity,
                defectQuantity,
                totalQuantity: passedQuantity + defectQuantity,
                allocated: Boolean(entry.itemId),
                legacy: false,
            };
        })
    );
    const legacy: QcEvent[] = options.lineRecords.flatMap((record: any) =>
        (record.qcEntries || [])
            .filter((entry: any) => !structuredSlots.has(`${id(record.dayId)}|${id(record.lineId)}|${entry.slotKey}`))
            .map((entry: any) => {
                const passedQuantity = Number(entry.passedQuantity || 0);
                const defectQuantity = Number(entry.defectQuantity || 0);
                return {
                    date: record.productionDate,
                    lineId: id(record.lineId),
                    lineCode: String(record.lineCode || ''),
                    lineName: record.lineName,
                    inspectionType: 'first_pass' as const,
                    passedQuantity,
                    defectQuantity,
                    totalQuantity: passedQuantity + defectQuantity,
                    allocated: false,
                    legacy: true,
                };
            })
    );
    return [...structured, ...legacy].filter((event) => matches(event, filters));
};

const emptyAccumulator = (identity: Record<string, unknown>) => ({
    ...identity,
    openingProduced: 0,
    openingPending: 0,
    openingPassed: 0,
    openingDefect: 0,
    historicalQualityComplete: true,
    periodProduced: 0,
    periodPassed: 0,
    periodDefect: 0,
    periodFirstPass: 0,
    periodRecheck: 0,
    trackedProducedToDate: 0,
    trackedPassedToDate: 0,
    trackedDefectToDate: 0,
    trackedFirstPassToDate: 0,
    trackedRecheckToDate: 0,
    legacyQuantity: 0,
    lastQcDate: undefined as string | undefined,
});

const aggregateRows = (
    kind: 'item' | 'line',
    productionEvents: ProductionEvent[],
    qcEvents: QcEvent[],
    qcOpeningEntries: any[],
    options: QcReportOptions,
    itemBreakdownPendingKnown: boolean
) => {
    const rows = new Map<string, ReturnType<typeof emptyAccumulator>>();
    const identityForProduction = (event: ProductionEvent) =>
        kind === 'item'
            ? {
                  itemId: event.itemId || UNALLOCATED,
                  itemCode: event.itemCode || 'Chưa phân bổ',
                  itemName: event.itemName,
              }
            : { lineId: event.lineId, lineCode: event.lineCode, lineName: event.lineName };
    const identityForQc = (event: QcEvent) =>
        kind === 'item'
            ? {
                  itemId: event.itemId || UNALLOCATED,
                  itemCode: event.itemCode || 'Chưa phân bổ',
                  itemName: event.itemName,
              }
            : { lineId: event.lineId, lineCode: event.lineCode, lineName: event.lineName };
    const keyOf = (identity: any) => String(kind === 'item' ? identity.itemId : identity.lineId);
    const ensure = (identity: any) => {
        const key = keyOf(identity);
        if (!rows.has(key)) rows.set(key, emptyAccumulator(identity));
        return rows.get(key)!;
    };

    productionEvents.forEach((event) => {
        const row = ensure(identityForProduction(event));
        if (event.opening) row.openingProduced += event.quantity;
        else if (event.date && event.date <= options.to) {
            row.trackedProducedToDate += event.quantity;
            if (event.date >= options.from) row.periodProduced += event.quantity;
        }
    });
    qcOpeningEntries
        .filter((entry) =>
            matches(
                { itemId: id(entry.itemId) || undefined, lineId: id(entry.lineId), orderCode: entry.orderCode },
                options.filters || {}
            )
        )
        .forEach((entry) => {
            const identity =
                kind === 'item'
                    ? {
                          itemId: id(entry.itemId) || UNALLOCATED,
                          itemCode: entry.itemCode || 'Chưa phân bổ',
                          itemName: entry.itemName,
                      }
                    : { lineId: id(entry.lineId), lineCode: entry.lineCode, lineName: entry.lineName };
            const row = ensure(identity);
            row.openingPending += Number(entry.pendingQuantity || 0);
            row.openingPassed += Number(entry.passedQuantity || 0);
            row.openingDefect += Number(entry.defectQuantity || 0);
            if (entry.mode === 'backlog_only') row.historicalQualityComplete = false;
        });
    qcEvents.forEach((event) => {
        if (!event.date || event.date > options.to) return;
        const row = ensure(identityForQc(event));
        if (event.inspectionType === 'first_pass') {
            row.trackedPassedToDate += event.passedQuantity;
            row.trackedDefectToDate += event.defectQuantity;
            row.trackedFirstPassToDate += event.totalQuantity;
            if (event.date >= options.from) {
                row.periodPassed += event.passedQuantity;
                row.periodDefect += event.defectQuantity;
                row.periodFirstPass += event.totalQuantity;
            }
        } else {
            row.trackedRecheckToDate += event.totalQuantity;
            if (event.date >= options.from) row.periodRecheck += event.totalQuantity;
        }
        if (event.legacy) row.legacyQuantity += event.totalQuantity;
        if (!row.lastQcDate || event.date > row.lastQcDate) row.lastQcDate = event.date;
    });

    const pendingKnown = Boolean(options.qcOpening.coverage?.available);
    return [...rows.values()]
        .map((row: any) => {
            const rowPendingKnown = pendingKnown && (kind === 'line' || itemBreakdownPendingKnown);
            const cumulativeProduced = row.openingProduced + row.trackedProducedToDate;
            const rawPending = row.openingPending + row.trackedProducedToDate - row.trackedFirstPassToDate;
            const pendingQuantity = rowPendingKnown ? Math.max(0, rawPending) : undefined;
            const overInspectedQuantity = rowPendingKnown ? Math.max(0, -rawPending) : 0;
            const cumulativeInspected = rowPendingKnown
                ? Math.max(0, cumulativeProduced - Number(pendingQuantity || 0))
                : undefined;
            const cumulativeKnownPassed = row.openingPassed + row.trackedPassedToDate;
            const cumulativeKnownDefect = row.openingDefect + row.trackedDefectToDate;
            const cumulativeKnownQuality = cumulativeKnownPassed + cumulativeKnownDefect;
            return {
                ...row,
                cumulativeProduced,
                cumulativeInspected,
                cumulativeKnownPassed,
                cumulativeKnownDefect,
                pendingQuantity,
                overInspectedQuantity,
                qcCompletionPercent:
                    rowPendingKnown && cumulativeProduced > 0
                        ? percent(Number(cumulativeInspected || 0), cumulativeProduced)
                        : undefined,
                periodDefectRate: percent(row.periodDefect, row.periodFirstPass),
                periodFirstPassYield: percent(row.periodPassed, row.periodFirstPass),
                cumulativeKnownDefectRate: percent(cumulativeKnownDefect, cumulativeKnownQuality),
            };
        })
        .sort(
            (left, right) =>
                Number(right.pendingQuantity || 0) - Number(left.pendingQuantity || 0) ||
                Number(right.periodDefect || 0) - Number(left.periodDefect || 0) ||
                String(kind === 'item' ? left.itemCode : left.lineCode).localeCompare(
                    String(kind === 'item' ? right.itemCode : right.lineCode)
                )
        );
};

const dateRange = (from: string, to: string) => {
    const result: string[] = [];
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (cursor <= end) {
        result.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
};

export const buildProductionQcReport = (options: QcReportOptions) => {
    const productionEvents = normalizeProductionEvents(options);
    const qcEvents = normalizeQcEvents(options);
    const qcOpeningEntries = options.qcOpening.entries || [];
    const allocationScopeFilters = options.filters?.lineId ? { lineId: options.filters.lineId } : {};
    const allocationScopeQc = normalizeQcEvents(options, allocationScopeFilters).filter(
        (event) => event.date && event.date <= options.to
    );
    const allocationScopeProduction = normalizeProductionEvents({
        ...options,
        filters: allocationScopeFilters,
    }).filter((event) => event.opening || (event.date && event.date <= options.to));
    const allocationScopeOpening = qcOpeningEntries.filter((entry) =>
        matches(
            { itemId: id(entry.itemId) || undefined, lineId: id(entry.lineId), orderCode: entry.orderCode },
            allocationScopeFilters
        )
    );
    const hasUnallocatedItemData =
        allocationScopeProduction.some((event) => !event.itemId && event.quantity > 0) ||
        allocationScopeOpening.some((entry) => !entry.itemId && Number(entry.pendingQuantity || 0) > 0) ||
        allocationScopeQc.some(
            (event) => event.inspectionType === 'first_pass' && !event.itemId && event.totalQuantity > 0
        );
    const hasUnallocatedOrderData =
        allocationScopeProduction.some((event) => !event.orderCode && event.quantity > 0) ||
        allocationScopeOpening.some((entry) => !entry.orderCode && Number(entry.pendingQuantity || 0) > 0) ||
        allocationScopeQc.some(
            (event) => event.inspectionType === 'first_pass' && !event.orderCode && event.totalQuantity > 0
        );
    const basePendingKnown = Boolean(options.qcOpening.coverage?.available);
    const itemBreakdownPendingKnown = basePendingKnown && !hasUnallocatedItemData;
    const scopedPendingKnown =
        basePendingKnown &&
        (!options.filters?.itemId || !hasUnallocatedItemData) &&
        (!options.filters?.orderCode || !hasUnallocatedOrderData);
    const itemRows = aggregateRows(
        'item',
        productionEvents,
        qcEvents,
        qcOpeningEntries,
        options,
        itemBreakdownPendingKnown
    );
    const lineRows = aggregateRows('line', productionEvents, qcEvents, qcOpeningEntries, options, true);
    const openingProduced = productionEvents
        .filter((event) => event.opening)
        .reduce((sum, event) => sum + event.quantity, 0);
    const trackedProduction = productionEvents.filter(
        (event) => !event.opening && event.date && event.date <= options.to
    );
    const trackedProducedToDate = trackedProduction.reduce((sum, event) => sum + event.quantity, 0);
    const periodProduced = trackedProduction
        .filter((event) => String(event.date) >= options.from)
        .reduce((sum, event) => sum + event.quantity, 0);
    const trackedQc = qcEvents.filter((event) => event.date && event.date <= options.to);
    const firstPassToDate = trackedQc
        .filter((event) => event.inspectionType === 'first_pass')
        .reduce((sum, event) => sum + event.totalQuantity, 0);
    const periodFirstPassEvents = trackedQc.filter(
        (event) => event.inspectionType === 'first_pass' && String(event.date) >= options.from
    );
    const periodPassed = periodFirstPassEvents.reduce((sum, event) => sum + event.passedQuantity, 0);
    const periodDefect = periodFirstPassEvents.reduce((sum, event) => sum + event.defectQuantity, 0);
    const periodFirstPass = periodPassed + periodDefect;
    const periodRecheck = trackedQc
        .filter((event) => event.inspectionType === 'recheck' && String(event.date) >= options.from)
        .reduce((sum, event) => sum + event.totalQuantity, 0);
    const openingPending = qcOpeningEntries
        .filter((entry) =>
            matches(
                { itemId: id(entry.itemId) || undefined, lineId: id(entry.lineId), orderCode: entry.orderCode },
                options.filters || {}
            )
        )
        .reduce((sum, entry) => sum + Number(entry.pendingQuantity || 0), 0);
    const openingPassed = qcOpeningEntries
        .filter((entry) =>
            matches(
                { itemId: id(entry.itemId) || undefined, lineId: id(entry.lineId), orderCode: entry.orderCode },
                options.filters || {}
            )
        )
        .reduce((sum, entry) => sum + Number(entry.passedQuantity || 0), 0);
    const openingDefect = qcOpeningEntries
        .filter((entry) =>
            matches(
                { itemId: id(entry.itemId) || undefined, lineId: id(entry.lineId), orderCode: entry.orderCode },
                options.filters || {}
            )
        )
        .reduce((sum, entry) => sum + Number(entry.defectQuantity || 0), 0);
    const pendingKnown = scopedPendingKnown;
    const rawPending = openingPending + trackedProducedToDate - firstPassToDate;
    const pendingQuantity = pendingKnown ? Math.max(0, rawPending) : undefined;
    const overInspectedQuantity = pendingKnown ? Math.max(0, -rawPending) : 0;
    const cumulativeProduced = openingProduced + trackedProducedToDate;
    const cumulativeInspected = pendingKnown
        ? Math.max(0, cumulativeProduced - Number(pendingQuantity || 0))
        : undefined;

    const beforeRangeProduced = trackedProduction
        .filter((event) => String(event.date) < options.from)
        .reduce((sum, event) => sum + event.quantity, 0);
    const beforeRangeFirstPass = trackedQc
        .filter((event) => event.inspectionType === 'first_pass' && String(event.date) < options.from)
        .reduce((sum, event) => sum + event.totalQuantity, 0);
    let runningProduced = openingProduced + beforeRangeProduced;
    let runningPending = openingPending + beforeRangeProduced - beforeRangeFirstPass;
    const trend = dateRange(options.from, options.to).map((date) => {
        const produced = trackedProduction
            .filter((event) => event.date === date)
            .reduce((sum, event) => sum + event.quantity, 0);
        const dayQc = trackedQc.filter((event) => event.date === date);
        const passed = dayQc
            .filter((event) => event.inspectionType === 'first_pass')
            .reduce((sum, event) => sum + event.passedQuantity, 0);
        const defect = dayQc
            .filter((event) => event.inspectionType === 'first_pass')
            .reduce((sum, event) => sum + event.defectQuantity, 0);
        const firstPass = passed + defect;
        const recheck = dayQc
            .filter((event) => event.inspectionType === 'recheck')
            .reduce((sum, event) => sum + event.totalQuantity, 0);
        runningProduced += produced;
        runningPending += produced - firstPass;
        return {
            date,
            produced,
            firstPass,
            passed,
            defect,
            recheck,
            defectRate: percent(defect, firstPass),
            cumulativeProduced: runningProduced,
            cumulativePending: pendingKnown ? Math.max(0, runningPending) : undefined,
            cumulativeInspected: pendingKnown ? Math.max(0, runningProduced - Math.max(0, runningPending)) : undefined,
            overInspectedQuantity: pendingKnown ? Math.max(0, -runningPending) : 0,
        };
    });

    const legacyQuantity = trackedQc
        .filter((event) => event.legacy)
        .reduce((sum, event) => sum + event.totalQuantity, 0);
    const allocatedFirstPass = trackedQc
        .filter((event) => event.inspectionType === 'first_pass' && event.allocated)
        .reduce((sum, event) => sum + event.totalQuantity, 0);
    const trackedFirstPassAll = trackedQc
        .filter((event) => event.inspectionType === 'first_pass')
        .reduce((sum, event) => sum + event.totalQuantity, 0);
    const exceptions: any[] = [];
    if (!basePendingKnown) {
        exceptions.push({
            id: 'missing-opening',
            type: 'missing_opening',
            severity: 'critical',
            title: 'Chưa có số đầu kỳ QC',
            description: 'Chưa thể kết luận lượng hàng còn chờ kiểm lũy kế.',
        });
    } else if (!pendingKnown) {
        exceptions.push({
            id: 'scope-unallocated',
            type: 'scope_unallocated',
            severity: 'critical',
            title: 'Phạm vi lọc còn dữ liệu chưa phân bổ',
            description:
                'Có sản lượng hoặc kết quả QC cũ chưa gán đủ mã hàng/đơn hàng, nên hệ thống không hiển thị tồn chờ chính xác giả cho phạm vi này.',
        });
    }
    if (legacyQuantity > 0) {
        exceptions.push({
            id: 'legacy-unallocated',
            type: 'legacy_unallocated',
            severity: 'warning',
            title: 'QC cũ chưa gán mã hàng',
            description: `${legacyQuantity.toLocaleString('vi-VN')} sản phẩm chưa thể phân bổ theo mã hàng.`,
            quantity: legacyQuantity,
        });
    }
    if (Number(options.qcOpening.coverage?.unallocatedPendingQuantity || 0) > 0) {
        exceptions.push({
            id: 'opening-unallocated',
            type: 'opening_unallocated',
            severity: 'warning',
            title: 'Tồn QC đầu kỳ chưa phân bổ',
            description: `${Number(options.qcOpening.coverage.unallocatedPendingQuantity).toLocaleString('vi-VN')} sản phẩm đầu kỳ chưa có mã hàng.`,
            quantity: Number(options.qcOpening.coverage.unallocatedPendingQuantity),
        });
    }
    itemRows
        .filter((row: any) => row.overInspectedQuantity > 0)
        .forEach((row: any) =>
            exceptions.push({
                id: `over-${row.itemId}`,
                type: 'over_inspected',
                severity: 'critical',
                itemId: row.itemId,
                itemCode: row.itemCode,
                title: `${row.itemCode}: QC vượt nguồn sản`,
                description: `Số kiểm lần đầu vượt nguồn ${row.overInspectedQuantity.toLocaleString('vi-VN')} sản phẩm.`,
                quantity: row.overInspectedQuantity,
            })
        );
    itemRows
        .filter((row: any) => row.periodFirstPass >= 50 && row.periodDefectRate >= 5)
        .forEach((row: any) =>
            exceptions.push({
                id: `defect-${row.itemId}`,
                type: 'high_defect',
                severity: row.periodDefectRate >= 10 ? 'critical' : 'warning',
                itemId: row.itemId,
                itemCode: row.itemCode,
                title: `${row.itemCode}: tỷ lệ lỗi cao`,
                description: `${row.periodDefectRate.toLocaleString('vi-VN')}% trong kỳ đã chọn.`,
                quantity: row.periodDefect,
            })
        );

    const openingKey = (entry: any) => `${id(entry.lineId)}|${id(entry.itemId)}|${order(entry.orderCode)}`;
    const fullQcOpeningKeys = new Set(
        qcOpeningEntries.filter((entry) => entry.mode === 'full').map((entry) => openingKey(entry))
    );
    const productionOpeningKeys = new Set(
        (options.productionOpening.entries || [])
            .filter((entry: any) => Number(entry.quantity || 0) > 0)
            .map((entry: any) => openingKey(entry))
    );
    const qualityHistoryComplete =
        Boolean(options.qcOpening.coverage?.historicalQualityComplete) &&
        [...productionOpeningKeys].every((key) => fullQcOpeningKeys.has(key));
    const exactCoveragePercent = Number(options.qcOpening.coverage?.exactCoveragePercent ?? 0);
    const allocatedOpeningPending = Number(options.qcOpening.coverage?.exactPendingQuantity || 0);
    const totalOpeningPending = Number(options.qcOpening.coverage?.pendingQuantity || 0);
    const allocationDenominator = totalOpeningPending + trackedFirstPassAll;
    const allocationCoveragePercent =
        allocationDenominator > 0
            ? percent(allocatedOpeningPending + allocatedFirstPass, allocationDenominator)
            : itemBreakdownPendingKnown
              ? 100
              : 0;
    const coverageStatus = !pendingKnown
        ? 'missing'
        : legacyQuantity > 0 || exactCoveragePercent < 100 || !qualityHistoryComplete || !itemBreakdownPendingKnown
          ? 'partial'
          : 'complete';

    return {
        meta: {
            plantId: options.plantId,
            plantName: options.plantName,
            plantCode: options.plantCode,
            from: options.from,
            to: options.to,
            generatedAt: options.generatedAt || new Date().toISOString(),
            filters: options.filters || {},
            coverage: {
                status: coverageStatus,
                productionOpeningAvailable: Boolean(options.productionOpening.coverage?.available),
                qcOpeningAvailable: pendingKnown,
                cutoffDate: options.qcOpening.coverage?.cutoffDate,
                trackingStartDate: options.trackingStartDate,
                exactCoveragePercent,
                allocationCoveragePercent,
                historicalQualityComplete: qualityHistoryComplete,
                legacyUnallocatedQuantity: legacyQuantity,
                openingUnallocatedPendingQuantity: Number(options.qcOpening.coverage?.unallocatedPendingQuantity || 0),
                itemBreakdownPendingKnown,
            },
        },
        summary: {
            periodProduced,
            periodFirstPass,
            periodPassed,
            periodDefect,
            periodRecheck,
            periodBalance: periodProduced - periodFirstPass,
            periodDefectRate: percent(periodDefect, periodFirstPass),
            periodFirstPassYield: percent(periodPassed, periodFirstPass),
            openingProduced,
            openingPending,
            openingKnownPassed: openingPassed,
            openingKnownDefect: openingDefect,
            trackedProducedToDate,
            trackedFirstPassToDate: firstPassToDate,
            cumulativeProduced,
            cumulativeInspected,
            pendingQuantity,
            pendingKnown,
            pendingUnknownReason: !basePendingKnown
                ? 'missing_opening'
                : !pendingKnown
                  ? 'unallocated_scope'
                  : undefined,
            overInspectedQuantity,
            qcCompletionPercent:
                pendingKnown && cumulativeProduced > 0
                    ? percent(Number(cumulativeInspected || 0), cumulativeProduced)
                    : undefined,
            itemCount: itemRows.filter((row: any) => row.itemId !== UNALLOCATED).length,
            lineCount: lineRows.length,
            exceptionCount: exceptions.length,
        },
        trend,
        items: itemRows,
        lines: lineRows,
        exceptions,
    };
};
