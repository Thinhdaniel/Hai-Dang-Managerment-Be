// Ngưỡng xác định "máy lệch vị trí" theo GPS lúc quét QR — dùng chung cho serializer + dashboard.
// Chống báo nhầm: GPS trong nhà xưởng hay máy đang vận chuyển có thể sai số lớn.

/** Sai số GPS tối đa (m) để coi lần quét là đáng tin. */
export const MAX_ACCURACY_M = 100;

/** Bán kính (m) coi như máy "đang ở" cơ sở gần nhất — xa hơn thì không kết luận lệch. */
export const AT_PLANT_RADIUS_M = 300;

type LastSeenLike = {
    plantId?: unknown;
    accuracy?: number | null;
    distanceM?: number | null;
    scannedAt?: Date | string | null;
} | null | undefined;

const toIdString = (value: unknown): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    const obj = value as { _id?: unknown; id?: unknown };
    if (obj._id) return String(obj._id);
    if (obj.id) return String(obj.id);
    return String(value);
};

/**
 * Đánh giá lệch vị trí: cơ sở GPS gần nhất (lastSeen.plantId) khác cơ sở hệ thống (officialPlantId),
 * và lần quét đủ tin cậy (sai số nhỏ + máy thực sự ở cạnh cơ sở kia).
 */
export const evaluateMislocation = (
    officialPlantId: string | undefined,
    lastSeen: LastSeenLike
): { mismatch: boolean; distanceM?: number; accuracy?: number } => {
    const actualPlantId = toIdString(lastSeen?.plantId);
    const distanceM = typeof lastSeen?.distanceM === 'number' ? lastSeen.distanceM : undefined;
    const accuracy = typeof lastSeen?.accuracy === 'number' ? lastSeen.accuracy : undefined;

    const confident =
        actualPlantId !== undefined &&
        officialPlantId !== undefined &&
        actualPlantId !== officialPlantId &&
        accuracy !== undefined &&
        accuracy <= MAX_ACCURACY_M &&
        distanceM !== undefined &&
        distanceM <= AT_PLANT_RADIUS_M;

    return { mismatch: confident, distanceM, accuracy };
};
