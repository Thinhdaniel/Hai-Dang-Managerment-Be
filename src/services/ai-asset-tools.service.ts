import { endOfDay, endOfMonth, endOfWeek, format, startOfDay, startOfMonth, startOfWeek, subWeeks } from 'date-fns';
import Asset from '@/models/Asset';
import Transfer from '@/models/Transfer';
import Plant from '@/models/Plant';
import Brand from '@/models/Brand';
import { expandPlantAlias } from '@/services/ai-material-insight.service';

const normalize = (v?: string) =>
    (v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
const rxOf = (v: string) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

const ASSET_STATUS_LABEL: Record<string, string> = {
    active: 'Đang chạy',
    maintenance: 'Bảo trì',
    broken: 'Hỏng',
    borrowing: 'Đang mượn',
    storage: 'Rảnh/Lưu kho',
    pending_disposal: 'Chuẩn bị thanh lý',
    disposed: 'Đã thanh lý',
    returned_to_partner: 'Đã trả đối tác',
};
const TRANSFER_STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ duyệt',
    approved: 'Đã duyệt',
    completed: 'Hoàn tất',
    rejected: 'Từ chối',
    cancelled: 'Đã huỷ',
};
const ACTIVE_TRANSFER = ['pending', 'approved'];

const loadPlants = async () => {
    const plants = await Plant.find({ isDeleted: { $ne: true } })
        .select('_id name')
        .lean();
    const nameById = new Map(plants.map((p: any) => [String(p._id), String(p.name)]));
    const resolve = (input?: string): string | undefined => {
        if (!input) return undefined;
        const q = expandPlantAlias(input);
        const hit =
            plants.find((p: any) => expandPlantAlias(p.name) === q) ||
            plants.find((p: any) => {
                const pn = expandPlantAlias(p.name);
                return pn.includes(q) || q.includes(pn);
            });
        return hit ? String((hit as any)._id) : undefined;
    };
    return { nameById, resolve };
};

const periodRange = (period?: string) => {
    const now = new Date();
    if (period === 'today') return { start: startOfDay(now), end: endOfDay(now), label: 'hôm nay' };
    if (period === 'week')
        return {
            start: startOfWeek(now, { weekStartsOn: 1 }),
            end: endOfWeek(now, { weekStartsOn: 1 }),
            label: 'tuần này',
        };
    if (period === 'month')
        return { start: startOfMonth(now), end: endOfMonth(now), label: `tháng ${format(now, 'MM/yyyy')}` };
    // mặc định "gần đây" = 2 tuần gần nhất
    return { start: startOfDay(subWeeks(now, 2)), end: endOfDay(now), label: 'gần đây (2 tuần)' };
};

// ============================================================
// 1) Tra cứu 1 MÁY cụ thể: vị trí + tình trạng + lệnh điều chuyển liên quan
// ============================================================
export const locateAsset = async (args: { query?: string }) => {
    const q = (args.query || '').trim();
    if (!q) return { found: 0, asset: null, others: [] };

    const { nameById } = await loadPlants();
    const qx = rxOf(q);
    // Ưu tiên khớp mã/serial/publicId chính xác; sau đó tới tên.
    const matches = await Asset.find({
        isDeleted: { $ne: true },
        $or: [{ machineCode: qx }, { serial: qx }, { publicId: q.toUpperCase() }, { name: qx }],
    })
        .populate('brandId', 'name')
        .limit(5)
        .lean();

    if (!matches.length) return { found: 0, asset: null, others: [] };

    // Chọn bản khớp tốt nhất: mã/serial trùng cụm > còn lại.
    const score = (a: any) => {
        const code = normalize(a.machineCode);
        const ser = normalize(a.serial);
        const nq = normalize(q);
        if (code === nq || ser === nq) return 3;
        if (code.includes(nq) || ser.includes(nq)) return 2;
        return 1;
    };
    matches.sort((a, b) => score(b) - score(a));
    const a: any = matches[0];

    const transfers = await Transfer.find({
        isDeleted: { $ne: true },
        $or: [{ assetId: a._id }, { assetIds: a._id }],
    })
        .sort({ transferDate: -1, createdAt: -1 })
        .limit(5)
        .lean();

    const lastSeenPlant = a.lastSeen?.plantId ? nameById.get(String(a.lastSeen.plantId)) : undefined;
    const managedPlant = nameById.get(String(a.plantId));
    const mislocated = Boolean(a.lastSeen?.plantId && String(a.lastSeen.plantId) !== String(a.plantId));

    const asset = {
        id: String(a._id),
        machineCode: a.machineCode,
        name: a.name,
        serial: a.serial || undefined,
        type: a.type,
        brandName: (a.brandId as any)?.name || undefined,
        status: a.status,
        statusLabel: ASSET_STATUS_LABEL[a.status] || a.status,
        managedPlant: managedPlant || 'Chưa gán cơ sở',
        area: a.area || undefined,
        lastSeenPlant,
        lastSeenAt: a.lastSeen?.scannedAt || undefined,
        lastSeenDistanceM: a.lastSeen?.distanceM ?? undefined,
        mislocated,
        nextMaintenanceDate: a.nextMaintenanceDate || undefined,
        activeTransfers: transfers
            .filter((t: any) => ACTIVE_TRANSFER.includes(t.status))
            .map((t: any) => ({
                from: nameById.get(String(t.fromPlantId)) || '?',
                to: nameById.get(String(t.toPlantId)) || '?',
                status: t.status,
                statusLabel: TRANSFER_STATUS_LABEL[t.status] || t.status,
                transferDate: t.transferDate,
                reason: t.reason,
            })),
        recentTransfers: transfers.map((t: any) => ({
            from: nameById.get(String(t.fromPlantId)) || '?',
            to: nameById.get(String(t.toPlantId)) || '?',
            statusLabel: TRANSFER_STATUS_LABEL[t.status] || t.status,
            transferDate: t.transferDate,
        })),
    };

    return {
        found: matches.length,
        asset,
        others: matches.slice(1).map((m: any) => ({ id: String(m._id), machineCode: m.machineCode, name: m.name })),
    };
};

// ============================================================
// 2) Lệnh ĐIỀU CHUYỂN: hôm nay / gần đây / theo trạng thái / cơ sở
// ============================================================
export const transferOrders = async (args: {
    period?: string;
    status?: string;
    plantName?: string;
    limit?: number;
}) => {
    const { nameById, resolve } = await loadPlants();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const r = periodRange(args.period);

    const filter: Record<string, any> = { isDeleted: { $ne: true } };
    // Lọc thời gian theo transferDate (ngày điều chuyển), fallback createdAt.
    filter.$or = [{ transferDate: { $gte: r.start, $lte: r.end } }, { createdAt: { $gte: r.start, $lte: r.end } }];
    if (args.status && TRANSFER_STATUS_LABEL[args.status]) filter.status = args.status;
    const plantId = resolve(args.plantName);
    if (plantId) filter.$and = [{ $or: [{ fromPlantId: plantId }, { toPlantId: plantId }] }];

    const count = await Transfer.countDocuments(filter);
    const docs = await Transfer.find(filter).sort({ transferDate: -1, createdAt: -1 }).limit(limit).lean();

    // Gom toàn bộ assetId để lấy mã máy trong 1 truy vấn.
    const allAssetIds = new Set<string>();
    docs.forEach((t: any) => {
        if (t.assetId) allAssetIds.add(String(t.assetId));
        (t.assetIds || []).forEach((id: any) => allAssetIds.add(String(id)));
    });
    const assets = allAssetIds.size
        ? await Asset.find({ _id: { $in: [...allAssetIds] } })
              .select('_id machineCode name')
              .lean()
        : [];
    const assetById = new Map(assets.map((x: any) => [String(x._id), { machineCode: x.machineCode, name: x.name }]));

    const orders = docs.map((t: any) => {
        const ids = new Set<string>();
        if (t.assetId) ids.add(String(t.assetId));
        (t.assetIds || []).forEach((id: any) => ids.add(String(id)));
        const machines = [...ids].map((id) => assetById.get(id)).filter(Boolean);
        return {
            id: String(t._id),
            from: nameById.get(String(t.fromPlantId)) || '?',
            to: nameById.get(String(t.toPlantId)) || '?',
            status: t.status,
            statusLabel: TRANSFER_STATUS_LABEL[t.status] || t.status,
            transferDate: t.transferDate,
            reason: t.reason,
            assetCount: machines.length,
            machines: machines.slice(0, 12),
        };
    });

    return { periodLabel: r.label, count, orders };
};
