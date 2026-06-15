// Tien ich tinh khoang cach toa do va tim co so gan nhat (dung cho dinh vi may theo GPS luc quet QR)

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export const isValidLatLng = (value: unknown): value is LatLng => {
    if (!value || typeof value !== 'object') return false;
    const { lat, lng } = value as Record<string, unknown>;
    return (
        typeof lat === 'number' &&
        typeof lng === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
    );
};

// Khoang cach Haversine (met) giua 2 toa do
export const haversineMeters = (a: LatLng, b: LatLng): number => {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Tim phan tu gan diem `point` nhat trong danh sach co toa do. Tra ve item + khoang cach (m).
export const findNearest = <T extends { coordinates?: LatLng | null }>(
    point: LatLng,
    items: T[]
): { item: T; distanceM: number } | null => {
    let best: { item: T; distanceM: number } | null = null;

    for (const item of items) {
        if (!isValidLatLng(item.coordinates)) continue;
        const distanceM = haversineMeters(point, item.coordinates);
        if (!best || distanceM < best.distanceM) {
            best = { item, distanceM };
        }
    }

    return best;
};
