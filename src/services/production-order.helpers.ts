export const PRODUCTION_ORDER_STATUSES = [
    'draft',
    'ready',
    'in_production',
    'paused',
    'completed',
    'cancelled',
] as const;

export type ProductionOrderStatus = (typeof PRODUCTION_ORDER_STATUSES)[number];
export type ProductionOrderPriority = 'low' | 'normal' | 'high' | 'urgent';

const PRIORITY_ALIASES: Record<string, ProductionOrderPriority> = {
    low: 'low',
    thap: 'low',
    normal: 'normal',
    'binh thuong': 'normal',
    high: 'high',
    cao: 'high',
    urgent: 'urgent',
    khan: 'urgent',
    gap: 'urgent',
};

const STATUS_ALIASES: Record<string, ProductionOrderStatus> = {
    draft: 'draft',
    nhap: 'draft',
    ready: 'ready',
    'san sang': 'ready',
    in_production: 'in_production',
    'in production': 'in_production',
    'dang san xuat': 'in_production',
    paused: 'paused',
    'tam dung': 'paused',
    completed: 'completed',
    'hoan thanh': 'completed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    'da huy': 'cancelled',
    huy: 'cancelled',
};

export const normalizeProductionOrderCode = (value: unknown) =>
    String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toUpperCase();

export const normalizeProductionOrderHeader = (value: unknown) =>
    String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

export const parseProductionOrderDate = (value: unknown): string | undefined => {
    if (!value) return undefined;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    const text = String(value).trim();
    const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const local = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    const parts = iso
        ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
        : local
          ? { year: Number(local[3]), month: Number(local[2]), day: Number(local[1]) }
          : undefined;
    if (!parts) return undefined;
    const parsed = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (
        parsed.getUTCFullYear() !== parts.year ||
        parsed.getUTCMonth() !== parts.month - 1 ||
        parsed.getUTCDate() !== parts.day
    ) {
        return undefined;
    }
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

export const parseProductionOrderPriority = (value: unknown): ProductionOrderPriority => {
    const normalized = normalizeProductionOrderHeader(value);
    return PRIORITY_ALIASES[normalized] || 'normal';
};

export const isRecognizedProductionOrderPriority = (value: unknown) =>
    Boolean(PRIORITY_ALIASES[normalizeProductionOrderHeader(value)]);

export const parseProductionOrderStatus = (value: unknown): ProductionOrderStatus => {
    const normalized = normalizeProductionOrderHeader(value);
    return STATUS_ALIASES[normalized] || STATUS_ALIASES[normalized.replace(/ /g, '_')] || 'draft';
};

export const isRecognizedProductionOrderStatus = (value: unknown) => {
    const normalized = normalizeProductionOrderHeader(value);
    return Boolean(STATUS_ALIASES[normalized] || STATUS_ALIASES[normalized.replace(/ /g, '_')]);
};

export const productionOrderDeadlineStatus = ({
    dueDate,
    remainingQuantity,
    today,
}: {
    dueDate: string;
    remainingQuantity: number;
    today: string;
}) => {
    if (remainingQuantity <= 0) return { code: 'completed' as const, daysRemaining: 0 };
    const due = Date.parse(`${dueDate}T00:00:00.000Z`);
    const current = Date.parse(`${today}T00:00:00.000Z`);
    const daysRemaining = Math.round((due - current) / 86_400_000);
    if (daysRemaining < 0) return { code: 'overdue' as const, daysRemaining };
    if (daysRemaining <= 3) return { code: 'due_soon' as const, daysRemaining };
    return { code: 'on_schedule' as const, daysRemaining };
};

export const summarizeProductionOrderProgress = ({
    totalQuantity,
    openingQuantity = 0,
    trackedQuantity = 0,
    futurePlannedQuantity = 0,
}: {
    totalQuantity: number;
    openingQuantity?: number;
    trackedQuantity?: number;
    futurePlannedQuantity?: number;
}) => {
    const producedQuantity = Math.max(0, openingQuantity + trackedQuantity);
    const remainingQuantity = Math.max(0, totalQuantity - producedQuantity);
    return {
        openingQuantity,
        trackedQuantity,
        producedQuantity,
        remainingQuantity,
        excessQuantity: Math.max(0, producedQuantity - totalQuantity),
        completionPercent: totalQuantity > 0 ? Number(((producedQuantity / totalQuantity) * 100).toFixed(1)) : 0,
        futurePlannedQuantity,
        unplannedQuantity: Math.max(0, remainingQuantity - futurePlannedQuantity),
    };
};
