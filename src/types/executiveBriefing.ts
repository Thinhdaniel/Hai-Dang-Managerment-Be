export type BriefingPeriodType = 'week' | 'month';
export type BriefingGenerationStatus = 'ready' | 'degraded';
export type BriefingSeverity = 'positive' | 'info' | 'warning' | 'critical';
export type BriefingTrigger = 'cron' | 'startup' | 'manual' | 'internal';

export type BriefingActionKey =
    | 'maintenance_overdue'
    | 'maintenance_list'
    | 'inventory_low_stock'
    | 'purchase_requests'
    | 'purchase_shortages'
    | 'supply_shortages'
    | 'transfer_backlog'
    | 'location_mismatch'
    | 'stocktake_anomaly'
    | 'qr_gap'
    | 'facility_report';

export interface BriefingPeriodRange {
    periodType: BriefingPeriodType;
    periodKey: string;
    periodLabel: string;
    rangeStart: Date;
    rangeEnd: Date;
    comparisonKey: string;
    comparisonLabel: string;
    comparisonStart: Date;
    comparisonEnd: Date;
}

export interface BriefingComparison {
    current: number;
    previous: number;
    delta: number;
    deltaPct: number | null;
}

export interface BriefingEvidence {
    key: string;
    label: string;
    value: number;
    formattedValue: string;
    previous?: number;
    formattedPrevious?: string;
    deltaPct?: number | null;
    unit: 'count' | 'percent' | 'currency' | 'days';
    tone: 'neutral' | 'positive' | 'warning' | 'critical';
}

export interface BriefingContentItem {
    id: string;
    title: string;
    detail: string;
    severity: BriefingSeverity;
    evidenceKeys: string[];
    actionKey?: BriefingActionKey;
    actionLabel?: string;
    actionUrl?: string;
}

export interface BriefingLowStockItem {
    materialId?: string;
    materialCode?: string;
    materialName: string;
    unit?: string;
    plantId?: string;
    plantName: string;
    currentStock: number;
    minStockLevel: number;
    shortage: number;
}

export interface BriefingAssetReference {
    id?: string;
    machineCode?: string;
    name?: string;
    plantName?: string;
    count?: number;
    status?: string;
    description?: string;
    occurredAt?: Date;
}

export interface BriefingPlantPerformance {
    plantId: string;
    plantName: string;
    plantCode?: string;
    operationalMachines: number;
    activeMachines: number;
    maintenanceMachines: number;
    brokenMachines: number;
    availabilityPct: number;
    newTickets: number;
    completedTickets: number;
    overdueTickets: number;
    lowStockCount: number;
    purchaseValue: number;
    distributionValue: number;
    stocktakeAnomalies: number;
    attentionLevel: 'stable' | 'watch' | 'critical';
}

export interface ExecutiveBriefingSnapshot {
    fleet: {
        registeredOwned: number;
        operationalMachines: number;
        activeMachines: number;
        maintenanceMachines: number;
        brokenMachines: number;
        storageMachines: number;
        pendingDisposalMachines: number;
        disposedMachines: number;
        unassignedMachines: number;
        linkedQrAssets: number;
        availabilityPct: number;
        qrCoveragePct: number;
    };
    maintenance: {
        newTickets: BriefingComparison;
        completedTickets: BriefingComparison;
        emergencyTickets: BriefingComparison;
        externalRepairCost: BriefingComparison;
        openTickets: number;
        overdueTickets: number;
        avgResolutionDays: number;
        repeatFailureAssets: number;
        completedWithEvidence: number;
        evidenceCoveragePct: number;
        topRepeatAssets: BriefingAssetReference[];
        notableIncidents: BriefingAssetReference[];
    };
    materials: {
        purchaseValue: BriefingComparison;
        distributionValue: BriefingComparison;
        pendingPurchaseRequests: number;
        approvedAwaitingOrder: number;
        partialPurchaseOrders: number;
        openPurchaseShortages: number;
        openPurchaseShortageQuantity: number;
        openSupplyShortages: number;
        openSupplyShortageQuantity: number;
        lowStockCount: number;
        lowStockItems: BriefingLowStockItem[];
    };
    operations: {
        transfersCreated: BriefingComparison;
        transfersCompleted: BriefingComparison;
        transferredAssets: number;
        openTransfers: number;
        mislocatedAssets: number;
        mislocatedItems: BriefingAssetReference[];
        stocktakeSessions: BriefingComparison;
        stocktakeMissing: number;
        stocktakeAnomalies: number;
    };
    plants: BriefingPlantPerformance[];
    evidence: BriefingEvidence[];
    dataDefinitions: Array<{ key: string; label: string; definition: string }>;
    dataWarnings: string[];
}

export interface ExecutiveBriefingContent {
    summary: string;
    highlights: BriefingContentItem[];
    risks: BriefingContentItem[];
    actions: BriefingContentItem[];
}
