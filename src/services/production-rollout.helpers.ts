export type ProductionRolloutStage = 'disabled' | 'preparing' | 'pilot' | 'live' | 'paused';

export type ProductionRolloutReadinessInput = {
    activeLines: number;
    activeItems: number;
    configuredScheduleDays: number;
    localManagers: number;
    lineLeaders: number;
    qcUsers: number;
    openOrders: number;
    approvedBoms: number;
    publishedPlanDays: number;
    acceptedPilotCode?: string;
};

export const normalizeProductionRolloutStage = (productionAccess?: {
    stage?: string;
    enabled?: boolean;
}): ProductionRolloutStage => {
    const stage = productionAccess?.stage;
    if (['disabled', 'preparing', 'pilot', 'live', 'paused'].includes(String(stage))) {
        return stage as ProductionRolloutStage;
    }
    return productionAccess?.enabled ? 'live' : 'disabled';
};

export const buildProductionRolloutReadiness = (input: ProductionRolloutReadinessInput) => {
    const checks = [
        {
            code: 'ACTIVE_LINES',
            label: 'Đã cấu hình chuyền hoạt động',
            value: input.activeLines,
            passed: input.activeLines > 0,
            requiredFor: 'pilot' as const,
            action: 'setup' as const,
        },
        {
            code: 'ACTIVE_ITEMS',
            label: 'Đã chuẩn hóa mã hàng',
            value: input.activeItems,
            passed: input.activeItems > 0,
            requiredFor: 'pilot' as const,
            action: 'setup' as const,
        },
        {
            code: 'SCHEDULE',
            label: 'Lịch làm việc đủ Thứ Hai - Thứ Bảy',
            value: input.configuredScheduleDays,
            passed: input.configuredScheduleDays >= 6,
            requiredFor: 'pilot' as const,
            action: 'setup' as const,
        },
        {
            code: 'LOCAL_MANAGER',
            label: 'Có quản lý phụ trách tại cơ sở',
            value: input.localManagers,
            passed: input.localManagers > 0,
            requiredFor: 'pilot' as const,
            action: 'users' as const,
        },
        {
            code: 'LINE_LEADER',
            label: 'Có tài khoản tổ trưởng',
            value: input.lineLeaders,
            passed: input.lineLeaders > 0,
            requiredFor: 'pilot' as const,
            action: 'users' as const,
        },
        {
            code: 'QC_USER',
            label: 'Có tài khoản QC',
            value: input.qcUsers,
            passed: input.qcUsers > 0,
            requiredFor: 'pilot' as const,
            action: 'users' as const,
        },
        {
            code: 'OPEN_ORDER',
            label: 'Có đơn hàng để chạy pilot',
            value: input.openOrders,
            passed: input.openOrders > 0,
            requiredFor: 'pilot' as const,
            action: 'orders' as const,
        },
        {
            code: 'APPROVED_BOM',
            label: 'Có BOM đã duyệt để kiểm readiness',
            value: input.approvedBoms,
            passed: input.approvedBoms > 0,
            requiredFor: 'pilot' as const,
            action: 'materials' as const,
        },
        {
            code: 'PUBLISHED_PLAN',
            label: 'Có kế hoạch ngày đã công bố',
            value: input.publishedPlanDays,
            passed: input.publishedPlanDays > 0,
            requiredFor: 'live' as const,
            action: 'planning' as const,
        },
        {
            code: 'SIGNED_UAT',
            label: 'Pilot đã được ký nghiệm thu',
            value: input.acceptedPilotCode || '',
            passed: Boolean(input.acceptedPilotCode),
            requiredFor: 'live' as const,
            action: 'pilot' as const,
        },
    ];
    const pilotBlockers = checks.filter((check) => check.requiredFor === 'pilot' && !check.passed);
    const liveBlockers = checks.filter((check) => !check.passed);
    return {
        checks,
        pilotReady: pilotBlockers.length === 0,
        liveReady: liveBlockers.length === 0,
        pilotBlockers: pilotBlockers.map((check) => check.code),
        liveBlockers: liveBlockers.map((check) => check.code),
        passedCount: checks.filter((check) => check.passed).length,
        totalCount: checks.length,
    };
};

const ALLOWED_TRANSITIONS: Record<ProductionRolloutStage, ProductionRolloutStage[]> = {
    disabled: ['preparing'],
    preparing: ['disabled', 'pilot'],
    pilot: ['preparing', 'live', 'paused'],
    live: ['paused'],
    paused: ['disabled', 'preparing', 'pilot', 'live'],
};

export const evaluateProductionRolloutTransition = ({
    fromStage,
    toStage,
    readiness,
}: {
    fromStage: ProductionRolloutStage;
    toStage: ProductionRolloutStage;
    readiness: ReturnType<typeof buildProductionRolloutReadiness>;
}) => {
    if (!ALLOWED_TRANSITIONS[fromStage].includes(toStage)) {
        return { allowed: false, reason: 'INVALID_TRANSITION' as const, blockers: [] as string[] };
    }
    if (toStage === 'pilot' && !readiness.pilotReady) {
        return { allowed: false, reason: 'PILOT_GATE_BLOCKED' as const, blockers: readiness.pilotBlockers };
    }
    if (toStage === 'live' && !readiness.liveReady) {
        return { allowed: false, reason: 'LIVE_GATE_BLOCKED' as const, blockers: readiness.liveBlockers };
    }
    return { allowed: true, reason: undefined, blockers: [] as string[] };
};
