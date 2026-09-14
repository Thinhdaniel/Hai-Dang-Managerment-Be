export type ProductionMaterialReadinessStatus = 'ready' | 'partial' | 'shortage' | 'unknown';

export const roundMaterialQuantity = (value: number) => Number(Math.max(0, value).toFixed(4));

export const calculateBomRequirement = ({
    orderQuantity,
    quantityPerUnit,
    wastagePercent,
}: {
    orderQuantity: number;
    quantityPerUnit: number;
    wastagePercent?: number;
}) =>
    roundMaterialQuantity(
        Math.max(0, orderQuantity) * Math.max(0, quantityPerUnit) * (1 + Math.max(0, wastagePercent || 0) / 100)
    );

export const calculateMaterialLineReadiness = ({
    requiredQuantity,
    onHandQuantity,
    reservedForOrderQuantity,
    totalReservedQuantity,
    confirmedInboundQuantity = 0,
}: {
    requiredQuantity: number;
    onHandQuantity: number;
    reservedForOrderQuantity: number;
    totalReservedQuantity: number;
    confirmedInboundQuantity?: number;
}) => {
    const required = roundMaterialQuantity(requiredQuantity);
    const onHand = roundMaterialQuantity(onHandQuantity);
    const ownReserved = roundMaterialQuantity(Math.min(onHand, reservedForOrderQuantity));
    const allReserved = roundMaterialQuantity(Math.max(ownReserved, totalReservedQuantity));
    const otherReserved = roundMaterialQuantity(Math.max(0, allReserved - ownReserved));
    const free = roundMaterialQuantity(Math.max(0, onHand - allReserved));
    const availableForOrder = roundMaterialQuantity(Math.min(required, ownReserved + free));
    const confirmedInbound = roundMaterialQuantity(confirmedInboundQuantity);
    const shortage = roundMaterialQuantity(Math.max(0, required - availableForOrder - confirmedInbound));
    const status: Exclude<ProductionMaterialReadinessStatus, 'unknown'> =
        shortage <= 0 ? 'ready' : availableForOrder + confirmedInbound > 0 ? 'partial' : 'shortage';

    return {
        requiredQuantity: required,
        onHandQuantity: onHand,
        reservedForOrderQuantity: ownReserved,
        reservedForOtherOrdersQuantity: otherReserved,
        freeQuantity: free,
        availableForOrderQuantity: availableForOrder,
        confirmedInboundQuantity: confirmedInbound,
        shortageQuantity: shortage,
        status,
    };
};

export const summarizeMaterialReadiness = (
    lines: Array<{
        isRequired: boolean;
        status: 'ready' | 'partial' | 'shortage';
        inboundQuantity?: number;
        confirmedInboundQuantity?: number;
        readyDate?: string;
    }>
) => {
    const requiredLines = lines.filter((line) => line.isRequired);
    if (!requiredLines.length) {
        return {
            status: 'unknown' as const,
            materialReadyDate: undefined,
            requiredLineCount: 0,
            readyLineCount: 0,
            shortageLineCount: 0,
            unknownInboundLineCount: 0,
        };
    }
    const readyLineCount = requiredLines.filter((line) => line.status === 'ready').length;
    const shortageLineCount = requiredLines.length - readyLineCount;
    const unknownInboundLineCount = requiredLines.filter(
        (line) =>
            line.status !== 'ready' && Number(line.inboundQuantity || 0) > Number(line.confirmedInboundQuantity || 0)
    ).length;
    const status: Exclude<ProductionMaterialReadinessStatus, 'unknown'> =
        readyLineCount === requiredLines.length ? 'ready' : readyLineCount > 0 ? 'partial' : 'shortage';
    const dates = requiredLines.map((line) => line.readyDate).filter((value): value is string => Boolean(value));
    const materialReadyDate =
        status === 'ready' && dates.length === requiredLines.length ? dates.sort().at(-1) : undefined;

    return {
        status,
        materialReadyDate,
        requiredLineCount: requiredLines.length,
        readyLineCount,
        shortageLineCount,
        unknownInboundLineCount,
    };
};

export const calculateReservableQuantity = ({
    requiredQuantity,
    onHandQuantity,
    reservedForOtherOrdersQuantity,
}: {
    requiredQuantity: number;
    onHandQuantity: number;
    reservedForOtherOrdersQuantity: number;
}) =>
    roundMaterialQuantity(
        Math.min(Math.max(0, requiredQuantity), Math.max(0, onHandQuantity - reservedForOtherOrdersQuantity))
    );
