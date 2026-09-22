type Input = {
    details: any[];
    cumulativeDetails: any[];
    prePeriodDetails: any[];
    plans: any[];
    orders: any[];
    openingEntries: any[];
    from: string;
    to: string;
    generatedAt: string;
    scope?: string;
};
const id = (value: any): string => String(value?._id ?? value?.id ?? value ?? '');
const round = (n: number) => Number(n.toFixed(1));
const localDate = (value: string) => new Date(new Date(value).getTime() + 7 * 3600000).toISOString().slice(0, 10);
const slotEnd = (date: string, slot: any) =>
    new Date(date + 'T00:00:00+07:00').getTime() + Number(slot.endMinute) * 60000;
const priority = ['needs_review', 'missing_reports', 'behind', 'ahead', 'on_track', 'not_due', 'no_plan'];
export const itemLineStatusLabels: Record<string, string> = {
    needs_review: 'Cần đối chiếu',
    missing_reports: 'Thiếu báo',
    behind: 'Chậm kế hoạch',
    ahead: 'Vượt tiến độ',
    on_track: 'Đúng tiến độ',
    not_due: 'Chưa đến hạn báo',
    no_plan: 'Chưa có kế hoạch',
};

// Keep order identity internally; the first level combines only the same item and line.
export const buildItemLineReport = (input: Input) => {
    const asOf = Math.min(new Date(input.generatedAt).getTime(), new Date(input.to + 'T23:59:59.999+07:00').getTime());
    const ordersById = new Map(input.orders.map((order) => [id(order), order]));
    const buckets = new Map<string, any>();
    const ensure = (source: any, line: any) => {
        const itemId = id(source.itemId) || source.itemCode || 'unknown-item';
        const lineId = id(line.lineId) || line.lineCode || 'unknown-line';
        const rawCode = String(source.orderCode || '')
            .trim()
            .toUpperCase();
        const order = source.orderId
            ? ordersById.get(id(source.orderId))
            : input.orders.find((order) => order.code === rawCode && id(order.itemId) === itemId);
        const validOrder = order && id(order.itemId) === itemId ? order : undefined;
        const orderKey = validOrder ? id(validOrder) : id(source.orderId) || rawCode || '__unassigned__';
        const key = JSON.stringify([itemId, lineId, orderKey]);
        if (!buckets.has(key))
            buckets.set(key, {
                key,
                itemId,
                itemCode: source.itemCode || 'N/A',
                itemName: source.itemName,
                unit: source.unit || 'SP',
                lineId,
                lineCode: line.lineCode || 'N/A',
                lineName: line.lineName,
                orderId: validOrder ? id(validOrder) : undefined,
                orderCode: validOrder?.code || rawCode || undefined,
                openingQuantity: 0,
                periodQuantity: 0,
                cumulativeQuantity: 0,
                plannedQuantity: 0,
                plannedToDateQuantity: 0,
                planActualQuantity: 0,
                unlinkedQuantity: 0,
                missingReports: 0,
                assignedQuantity: null,
                dueDate: null,
                needsReview: Boolean(source.orderId && !validOrder),
                days: new Map<string, any>(),
            });
        return buckets.get(key)!;
    };
    const dayFor = (row: any, date: string) => {
        if (!row.days.has(date))
            row.days.set(date, {
                productionDate: date,
                quantity: 0,
                targetQuantity: 0,
                plannedQuantity: 0,
                carryQuantity: 0,
                plannedToDateQuantity: 0,
                slots: [] as any[],
            });
        return row.days.get(date);
    };
    const allocations = input.plans.flatMap((plan) =>
        (plan.allocations || []).map((a: any) => ({
            ...a,
            id: id(a),
            productionDate: plan.productionDate,
            timeSlots: plan.timeSlots || [],
        }))
    );
    const allocationMap = new Map(allocations.map((a) => [a.id, a]));
    const rootFor = (a: any) => {
        const seen = new Set<string>();
        while (a?.sourceType === 'carry_over') {
            if (!a.sourceAllocationId || seen.has(a.id)) return undefined;
            seen.add(a.id);
            a = allocationMap.get(id(a.sourceAllocationId));
        }
        return a;
    };
    const slotsFor = (a: any) => {
        const slots = a.timeSlots.filter((s: any) => s.isActive !== false);
        const start = slots.findIndex((s: any) => s.key === a.startSlotKey);
        const end = slots.findIndex((s: any) => s.key === a.endSlotKey);
        return start < 0 || end < start ? [] : slots.slice(start, end + 1);
    };
    const plannedDueKeys = new Set<string>();
    const reportedDueKeys = new Set<string>();
    const bucketDueKeys = new Map<string, Set<string>>();
    for (const a of allocations) {
        const row = ensure(a, a);
        const inPeriod = a.productionDate >= input.from && a.productionDate <= input.to;
        const day = inPeriod ? dayFor(row, a.productionDate) : undefined;
        if (inPeriod) {
            row.plannedQuantity += Number(a.plannedQuantity || 0);
            day.plannedQuantity += Number(a.plannedQuantity || 0);
            if (a.sourceType === 'carry_over') day.carryQuantity += Number(a.plannedQuantity || 0);
        }
        const slots = slotsFor(a);
        if (!slots.length) {
            row.needsReview = true;
            continue;
        }
        const totalMinutes = slots.reduce((n: number, s: any) => n + s.endMinute - s.startMinute, 0);
        const due = slots.filter((s: any) => slotEnd(a.productionDate, s) <= asOf);
        // Carry-over reschedules an existing obligation; it must not increase the original total.
        if (a.sourceType !== 'carry_over') {
            const elapsed = due.reduce((n: number, s: any) => n + s.endMinute - s.startMinute, 0);
            const expected = totalMinutes > 0 ? Math.floor((Number(a.plannedQuantity) * elapsed) / totalMinutes) : 0;
            row.plannedToDateQuantity += expected;
            if (day) day.plannedToDateQuantity += expected;
        } else {
            const root = rootFor(a);
            if (!root || ensure(root, root).key !== row.key) row.needsReview = true;
        }
        for (const s of due) {
            const k = JSON.stringify([a.productionDate, row.key, s.key]);
            plannedDueKeys.add(k);
            if (!bucketDueKeys.has(row.key)) bucketDueKeys.set(row.key, new Set());
            bucketDueKeys.get(row.key)!.add(k);
        }
    }
    for (const entry of input.openingEntries) {
        if (!entry.itemId || entry.allocationState === 'unallocated') continue;
        const row = ensure(entry, entry);
        row.openingQuantity += Number(entry.quantity || 0);
        row.cumulativeQuantity += Number(entry.quantity || 0);
    }
    const accumulate = (details: any[], field: string) => {
        for (const detail of details)
            for (const line of detail.lines || []) {
                const runs = new Map((line.runs || []).map((r: any) => [id(r), r]));
                for (const entry of line.entries || []) {
                    const run: any = runs.get(id(entry.runId));
                    if (run) ensure(run, line)[field] += Number(entry.quantity || 0);
                }
            }
    };
    accumulate(input.prePeriodDetails, 'openingQuantity');
    accumulate(input.cumulativeDetails, 'cumulativeQuantity');
    accumulate(input.details, 'periodQuantity');
    const details = new Map([...input.cumulativeDetails, ...input.details].map((d) => [d.productionDate, d]));
    for (const detail of details.values())
        for (const line of detail.lines || []) {
            const runs = new Map((line.runs || []).map((r: any) => [id(r), r]));
            for (const slot of line.slotValues || []) {
                const run: any = runs.get(id(slot.runId));
                if (!run) continue;
                const row = ensure(run, line);
                const timeSlot = (detail.timeSlots || []).find((s: any) => s.key === slot.key);
                if (!timeSlot) continue;
                const entries = (line.entries || []).filter(
                    (e: any) => id(e.runId) === id(run) && e.slotKey === slot.key
                );
                const due = slotEnd(detail.productionDate, timeSlot) <= asOf;
                const k = JSON.stringify([detail.productionDate, row.key, slot.key]);
                if (entries.length && due) reportedDueKeys.add(k);
                if (!entries.length && due && !plannedDueKeys.has(k)) row.missingReports += 1;
                const inPeriod = detail.productionDate >= input.from && detail.productionDate <= input.to;
                if (inPeriod) {
                    const day = dayFor(row, detail.productionDate);
                    day.targetQuantity += Number(slot.target || 0);
                    day.slots.push({
                        slotKey: slot.key,
                        label: timeSlot.label || slot.key,
                        target: Number(slot.target || 0),
                        reported: entries.length > 0,
                        quantity: entries.reduce((n: number, e: any) => n + Number(e.quantity || 0), 0),
                        note: entries
                            .map((e: any) => e.note)
                            .filter(Boolean)
                            .join('; '),
                        due,
                        endMinute: timeSlot.endMinute,
                    });
                }
            }
            for (const entry of line.entries || []) {
                const run: any = runs.get(id(entry.runId));
                if (!run) continue;
                const row = ensure(run, line);
                if (detail.productionDate >= input.from && detail.productionDate <= input.to) {
                    dayFor(row, detail.productionDate).quantity += Number(entry.quantity || 0);
                }
                const a = allocationMap.get(id(run.planAllocationId));
                const timeSlot = (detail.timeSlots || []).find((s: any) => s.key === entry.slotKey);
                if (!timeSlot || slotEnd(detail.productionDate, timeSlot) > asOf) continue;
                if (
                    a &&
                    a.productionDate === detail.productionDate &&
                    id(a.lineId) === row.lineId &&
                    id(a.itemId) === row.itemId &&
                    ensure(a, a).key === row.key &&
                    slotsFor(a).some((s: any) => s.key === entry.slotKey)
                ) {
                    row.planActualQuantity += Number(entry.quantity || 0);
                } else row.unlinkedQuantity += Number(entry.quantity || 0);
            }
        }
    for (const order of input.orders) {
        if (order.createdAt && localDate(order.createdAt) > input.to) continue;
        let assignments = order.lineAssignments || [];
        // Reconstruct assignments at the report cutoff, not today's mutable allocation.
        for (const event of [...(order.history || [])].reverse()) {
            if (event.at && new Date(event.at).getTime() > asOf && event.previousAssignments)
                assignments = event.previousAssignments;
        }
        for (const a of assignments) {
            if (a.startDate > input.to) continue;
            const row = ensure({ ...order, orderId: order._id || order.id, orderCode: order.code }, a);
            row.assignedQuantity = Number(a.quantity);
            row.dueDate = a.dueDate;
        }
    }
    const result = new Map<string, any>();
    for (const row of buckets.values()) {
        const missing = [...(bucketDueKeys.get(row.key) || [])].filter((k) => !reportedDueKeys.has(k)).length;
        row.missingReports += missing;
        row.deltaQuantity =
            row.plannedToDateQuantity > 0 ? round(row.planActualQuantity - row.plannedToDateQuantity) : null;
        row.remainingQuantity =
            row.assignedQuantity === null ? null : round(Math.max(0, row.assignedQuantity - row.cumulativeQuantity));
        row.overQuantity =
            row.assignedQuantity === null ? null : round(Math.max(0, row.cumulativeQuantity - row.assignedQuantity));
        row.completionPercent = row.assignedQuantity
            ? round((row.cumulativeQuantity / row.assignedQuantity) * 100)
            : null;
        row.status =
            row.needsReview || (row.plannedToDateQuantity > 0 && row.unlinkedQuantity > 0)
                ? 'needs_review'
                : row.missingReports > 0
                  ? 'missing_reports'
                  : row.deltaQuantity === null
                    ? row.plannedQuantity > 0
                        ? 'not_due'
                        : 'no_plan'
                    : row.deltaQuantity < 0
                      ? 'behind'
                      : row.deltaQuantity > 0
                        ? 'ahead'
                        : 'on_track';
        for (const field of [
            'openingQuantity',
            'periodQuantity',
            'cumulativeQuantity',
            'plannedQuantity',
            'plannedToDateQuantity',
            'planActualQuantity',
            'unlinkedQuantity',
        ])
            row[field] = round(row[field]);
        row.days = [...row.days.values()].sort((a: any, b: any) => a.productionDate.localeCompare(b.productionDate));
        row.days.forEach((d: any) => {
            d.quantity = round(d.quantity);
            d.slots.sort((a: any, b: any) => a.endMinute - b.endMinute);
        });
        delete row.needsReview;
        const key = JSON.stringify([row.itemId, row.lineId]);
        if (!result.has(key))
            result.set(key, {
                key,
                itemId: row.itemId,
                itemCode: row.itemCode,
                itemName: row.itemName,
                unit: row.unit,
                lineId: row.lineId,
                lineCode: row.lineCode,
                lineName: row.lineName,
                orders: [],
            });
        result.get(key).orders.push(row);
    }
    return [...result.values()]
        .map((group) => {
            const rows = group.orders;
            for (const field of [
                'openingQuantity',
                'periodQuantity',
                'cumulativeQuantity',
                'plannedQuantity',
                'plannedToDateQuantity',
                'planActualQuantity',
                'unlinkedQuantity',
                'missingReports',
            ]) {
                group[field] = round(rows.reduce((n: number, r: any) => n + r[field], 0));
            }
            group.unassignedQuantity = round(
                rows
                    .filter((r: any) => r.assignedQuantity === null)
                    .reduce((n: number, r: any) => n + r.cumulativeQuantity, 0)
            );
            const assigned = rows.filter((r: any) => r.assignedQuantity !== null);
            group.assignedQuantity = assigned.length
                ? assigned.reduce((n: number, r: any) => n + r.assignedQuantity, 0)
                : null;
            group.remainingQuantity = assigned.length
                ? round(assigned.reduce((n: number, r: any) => n + r.remainingQuantity, 0))
                : null;
            group.completionPercent =
                group.assignedQuantity && group.unassignedQuantity === 0
                    ? round(
                          (assigned.reduce(
                              (n: number, r: any) => n + Math.min(r.cumulativeQuantity, r.assignedQuantity),
                              0
                          ) /
                              group.assignedQuantity) *
                              100
                      )
                    : null;
            group.deltaQuantity =
                group.plannedToDateQuantity > 0 ? round(group.planActualQuantity - group.plannedToDateQuantity) : null;
            group.status = priority.find((s) => rows.some((r: any) => r.status === s)) || 'no_plan';
            return group;
        })
        .sort((a, b) => a.itemCode.localeCompare(b.itemCode) || a.lineCode.localeCompare(b.lineCode));
};
