const sameId = (left: unknown, right: unknown) => String(left ?? '') === String(right ?? '');

export type ProductionPriceCorrectionImpact = {
    recordIds: unknown[];
    dayIds: unknown[];
    productionDates: string[];
    affectedRecordCount: number;
    affectedDayCount: number;
    affectedRunCount: number;
    affectedEntryCount: number;
    planIds: unknown[];
    affectedPlanCount: number;
    affectedPlanAllocationCount: number;
};

export const shouldProcessProductionPriceUpdate = ({
    priceChanged,
    unitPriceMode,
    unitPriceEffectiveFrom,
}: {
    priceChanged: boolean;
    unitPriceMode: string;
    unitPriceEffectiveFrom?: unknown;
}) => priceChanged || (unitPriceMode === 'recalculate_from_date' && Boolean(unitPriceEffectiveFrom));

export const summarizeProductionPriceCorrection = ({
    records,
    plans,
    itemId,
    nextUnitPrice,
}: {
    records: any[];
    plans: any[];
    itemId: unknown;
    nextUnitPrice: number;
}): ProductionPriceCorrectionImpact => {
    const recordIds: unknown[] = [];
    const dayIds: unknown[] = [];
    const productionDates = new Set<string>();
    let affectedRunCount = 0;
    let affectedEntryCount = 0;

    records.forEach((record) => {
        const affectedRunIds = new Set<string>();
        (record.runs || []).forEach((run: any) => {
            if (!sameId(run.itemId, itemId) || Number(run.unitPriceSnapshot || 0) === nextUnitPrice) return;
            affectedRunCount += 1;
            affectedRunIds.add(String(run._id ?? run.id));
        });
        if (!affectedRunIds.size) return;

        recordIds.push(record._id ?? record.id);
        if (record.dayId) dayIds.push(record.dayId);
        if (record.productionDate) productionDates.add(String(record.productionDate));
        affectedEntryCount += (record.entries || []).filter((entry: any) =>
            affectedRunIds.has(String(entry.runId))
        ).length;
    });

    const planIds: unknown[] = [];
    let affectedPlanAllocationCount = 0;
    plans.forEach((plan) => {
        const count = (plan.allocations || []).filter(
            (allocation: any) =>
                sameId(allocation.itemId, itemId) && Number(allocation.unitPriceSnapshot || 0) !== nextUnitPrice
        ).length;
        if (!count) return;
        planIds.push(plan._id ?? plan.id);
        affectedPlanAllocationCount += count;
    });

    return {
        recordIds,
        dayIds: [...new Map(dayIds.map((id) => [String(id), id])).values()],
        productionDates: [...productionDates].sort(),
        affectedRecordCount: recordIds.length,
        affectedDayCount: productionDates.size,
        affectedRunCount,
        affectedEntryCount,
        planIds,
        affectedPlanCount: planIds.length,
        affectedPlanAllocationCount,
    };
};
