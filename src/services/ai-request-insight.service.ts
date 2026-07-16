import DistributionRecord from '@/models/DistributionRecord';
import Plant from '@/models/Plant';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseRequest from '@/models/PurchaseRequest';
import SupplyShortage from '@/models/SupplyShortage';
import { addVietnamDays, endOfVietnamDay, startOfVietnamDay, vietnamCalendarParts } from '@/utils/vietnamDate';
import { Types } from 'mongoose';

type PeriodType = 'today' | 'yesterday' | 'week' | 'month' | 'all';
type RequestKind = 'supply' | 'purchase' | 'technical' | 'purchase_all';

type RequestArgs = {
    kind?: RequestKind;
    requestType?: string;
    search?: string;
    requestCode?: string;
    status?: string;
    plantName?: string;
    materialName?: string;
    period?: PeriodType;
    limit?: number;
    staleDays?: number;
    startDate?: string;
    endDate?: string;
    // Phạm vi bắt buộc do policy của trợ lý gắn vào. Không nhận trực tiếp từ HTTP/client.
    scopePlantId?: string;
    scopeUserId?: string;
};

const REQUEST_STATUS_LABEL: Record<string, string> = {
    draft: 'Bản nháp',
    pending: 'Chờ duyệt',
    approved: 'Đã duyệt',
    rejected: 'Từ chối',
    ordered: 'Đã lên đơn',
    received: 'Đã nhận',
    in_progress: 'Đang xử lý',
    partially_distributed: 'Cấp một phần',
    distributed: 'Đã cấp phát',
};

const PO_STATUS_LABEL: Record<string, string> = {
    draft: 'Bản nháp',
    confirmed: 'Đã duyệt',
    ordered: 'Đã đặt',
    partially_received: 'Nhận một phần',
    received: 'Đã nhận',
    cancelled: 'Đã huỷ',
};

const SHORTAGE_STATUS_LABEL: Record<string, string> = {
    outstanding: 'Còn thiếu',
    partially_settled: 'Bù một phần',
    settled: 'Đã bù đủ',
    cancelled: 'Đã huỷ',
};

const normalize = (v?: string) =>
    (v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

const expandPlantAlias = (v?: string) => normalize(v).replace(/\bc\.?\s*s\.?\s*(\d+)/g, 'co so $1');

const escapeRx = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rxOf = (v: string) => new RegExp(escapeRx(v.trim()), 'i');

const toId = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value.toHexString === 'function') return value.toHexString();
    if (value._id) return toId(value._id);
    if (value.id) return String(value.id);
    return String(value);
};

const toIso = (value: any) => (value ? new Date(value).toISOString() : undefined);

const personName = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    return value.name || value.fullname || value.email || toId(value);
};

const plantName = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    return value.name || value.code || toId(value);
};

const clampLimit = (limit?: number, max = 50) => Math.min(Math.max(Number(limit) || 12, 1), max);

const periodRange = (period?: PeriodType) => {
    const now = new Date();
    if (period === 'today') {
        return { start: startOfVietnamDay(now), end: endOfVietnamDay(now), label: 'hôm nay' };
    }
    if (period === 'yesterday') {
        const yesterday = addVietnamDays(now, -1);
        return { start: startOfVietnamDay(yesterday), end: endOfVietnamDay(yesterday), label: 'hôm qua' };
    }
    if (period === 'week') {
        const day = vietnamCalendarParts(now).weekday || 7;
        const start = startOfVietnamDay(addVietnamDays(now, -day + 1));
        const end = endOfVietnamDay(addVietnamDays(start, 6));
        return { start, end, label: 'tuần này' };
    }
    if (period === 'month' || !period) {
        const { year, month } = vietnamCalendarParts(now);
        const start = new Date(Date.UTC(year, month, 1) - 7 * 60 * 60 * 1000);
        const end = new Date(Date.UTC(year, month + 1, 1) - 7 * 60 * 60 * 1000 - 1);
        return { start, end, label: `tháng ${String(month + 1).padStart(2, '0')}/${year}` };
    }
    return { start: undefined, end: undefined, label: 'toàn bộ thời gian' };
};

const customPeriodRange = (startDate?: string, endDate?: string) => {
    if (!startDate && !endDate) return undefined;
    const from = startDate || endDate!;
    const to = endDate || startDate!;
    const display = (value: string) => value.split('-').reverse().join('/');
    return {
        start: new Date(`${from}T00:00:00.000+07:00`),
        end: new Date(`${to}T23:59:59.999+07:00`),
        label: from === to ? `ngày ${display(from)}` : `từ ${display(from)} đến ${display(to)}`,
    };
};

const daysBetween = (from?: Date | string, to = new Date()) => {
    if (!from) return 0;
    return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 86400000));
};

const loadPlants = async () => {
    const plants = await Plant.find({ isDeleted: { $ne: true } })
        .select('_id name code')
        .lean();
    const nameById = new Map(plants.map((p: any) => [String(p._id), String(p.name || p.code)]));
    const resolve = (input?: string) => {
        if (!input) return undefined;
        const q = expandPlantAlias(input);
        const hit =
            plants.find((p: any) => expandPlantAlias(p.name) === q || expandPlantAlias(p.code) === q) ||
            plants.find((p: any) => {
                const pn = expandPlantAlias(`${p.name || ''} ${p.code || ''}`);
                return pn.includes(q) || q.includes(pn);
            });
        return hit ? String((hit as any)._id) : undefined;
    };
    return { nameById, resolve };
};

const requestTypeFilter = (kind?: RequestKind | string) => {
    if (kind === 'supply' || kind === 'supply_request') return 'supply_request';
    if (kind === 'technical' || kind === 'technical_purchase') return 'technical_purchase';
    if (kind === 'purchase' || kind === 'purchase_request') return 'purchase';
    return { $in: ['purchase', 'technical_purchase'] };
};

const buildFilter = async (args: RequestArgs, defaultKind: RequestKind) => {
    const kind = (args.kind || args.requestType || defaultKind) as RequestKind;
    const { resolve } = await loadPlants();
    const plantId = resolve(args.plantName);
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        requestType: requestTypeFilter(kind),
    };
    const and: Record<string, any>[] = [];
    const q = args.requestCode || args.search || args.materialName;
    if (q) {
        const rx = rxOf(String(q));
        and.push({
            $or: [
                { requestCode: rx },
                { requesterName: rx },
                { department: rx },
                { note: rx },
                { 'items.materialName': rx },
                { 'items.supplierName': rx },
                { 'items.proposedBy': rx },
                { 'items.purpose': rx },
            ],
        });
    }
    if (args.materialName && args.materialName !== q) {
        and.push({ 'items.materialName': rxOf(String(args.materialName)) });
    }
    if (args.status) filter.status = args.status;
    if (plantId) {
        const oid = new Types.ObjectId(plantId);
        and.push({
            $or: [{ plantId: oid }, { fromPlantId: oid }, { toPlantId: oid }, { 'items.plantId': oid }],
        });
    }
    if (args.scopePlantId) {
        const scopedPlantId = new Types.ObjectId(args.scopePlantId);
        and.push({
            $or: [
                { plantId: scopedPlantId },
                { fromPlantId: scopedPlantId },
                { toPlantId: scopedPlantId },
                { 'items.plantId': scopedPlantId },
            ],
        });
    }
    if (args.scopeUserId) filter.requestedBy = new Types.ObjectId(args.scopeUserId);
    const customRange = customPeriodRange(args.startDate, args.endDate);
    if (customRange || args.period !== 'all') {
        const range = customRange || periodRange(args.period);
        filter.createdAt = { $gte: range.start, $lte: range.end };
    }
    if (and.length) filter.$and = and;
    return { filter, kind, periodLabel: customRange?.label || periodRange(args.period).label };
};

const fetchRequests = async (args: RequestArgs, defaultKind: RequestKind, maxLimit = 200) => {
    const { filter, kind, periodLabel } = await buildFilter(args, defaultKind);
    const docs = await PurchaseRequest.find(filter)
        .populate('plantId')
        .populate('fromPlantId')
        .populate('toPlantId')
        .populate('requestedBy')
        .populate('approvedBy')
        .sort({ createdAt: -1 })
        .limit(clampLimit(args.limit, maxLimit))
        .lean();
    const total = await PurchaseRequest.countDocuments(filter);
    return { docs, total, kind, periodLabel };
};

const buildPurchaseLinks = async (requests: any[]) => {
    const ids = requests.map((r) => toId(r)).filter(Boolean) as string[];
    const codes = requests.map((r) => r.requestCode).filter(Boolean);
    if (!ids.length && !codes.length) return new Map<string, any>();

    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const orders = await PurchaseOrder.find({
        isDeleted: { $ne: true },
        $or: [
            { purchaseRequestIds: { $in: objectIds } },
            { purchaseRequestCodes: { $in: codes } },
            { 'items.purchaseRequestId': { $in: objectIds } },
            { 'items.purchaseRequestCode': { $in: codes } },
        ],
    })
        .sort({ createdAt: -1 })
        .lean();

    const map = new Map<string, any>();
    const ensure = (key: string) => {
        if (!map.has(key)) {
            map.set(key, {
                orderCount: 0,
                orderCodes: [] as string[],
                statuses: [] as string[],
                orderedQty: 0,
                receivedQty: 0,
                missingQty: 0,
                totalWithVat: 0,
                firstOrderedAt: undefined as string | undefined,
                lastReceivedAt: undefined as string | undefined,
            });
        }
        return map.get(key);
    };

    for (const order of orders as any[]) {
        const relatedKeys = new Set<string>();
        for (const id of order.purchaseRequestIds || []) relatedKeys.add(String(id));
        for (const code of order.purchaseRequestCodes || []) relatedKeys.add(String(code));
        for (const item of order.items || []) {
            if (item.purchaseRequestId) relatedKeys.add(String(item.purchaseRequestId));
            if (item.purchaseRequestCode) relatedKeys.add(String(item.purchaseRequestCode));
        }
        for (const key of relatedKeys) {
            const itemRows = (order.items || []).filter(
                (item: any) =>
                    item.lineStatus !== 'cancelled' &&
                    (String(item.purchaseRequestId || '') === key ||
                        String(item.purchaseRequestCode || '') === key ||
                        (order.purchaseRequestIds || []).some((id: any) => String(id) === key) ||
                        (order.purchaseRequestCodes || []).some((code: string) => String(code) === key))
            );
            const summary = ensure(key);
            summary.orderCount += 1;
            if (order.orderCode) summary.orderCodes.push(order.orderCode);
            summary.statuses.push(PO_STATUS_LABEL[order.status] || order.status);
            summary.orderedQty += itemRows.reduce((s: number, item: any) => s + Number(item.quantityOrdered || 0), 0);
            summary.receivedQty += itemRows.reduce((s: number, item: any) => s + Number(item.quantityReceived || 0), 0);
            summary.missingQty += itemRows.reduce((s: number, item: any) => s + Number(item.quantityMissing || 0), 0);
            summary.totalWithVat += itemRows.reduce(
                (s: number, item: any) => s + Number(item.totalWithVat || item.totalPrice || 0),
                0
            );
            summary.firstOrderedAt = summary.firstOrderedAt || toIso(order.orderedAt || order.createdAt);
            if (order.receivedAt) summary.lastReceivedAt = toIso(order.receivedAt);
        }
    }

    for (const summary of map.values()) {
        summary.orderCodes = [...new Set(summary.orderCodes)];
        summary.statuses = [...new Set(summary.statuses)];
        summary.totalWithVat = Math.round(summary.totalWithVat);
        summary.orderedQty = Math.round(summary.orderedQty);
        summary.receivedQty = Math.round(summary.receivedQty);
        summary.missingQty = Math.round(summary.missingQty);
    }
    return map;
};

const buildSupplyLinks = async (requests: any[]) => {
    const ids = requests.map((r) => toId(r)).filter(Boolean) as string[];
    if (!ids.length) return new Map<string, any>();
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const [records, shortages] = await Promise.all([
        DistributionRecord.find({ isDeleted: { $ne: true }, supplyRequestId: { $in: objectIds } })
            .sort({ createdAt: -1 })
            .lean(),
        SupplyShortage.find({ isDeleted: { $ne: true }, originalSupplyRequestId: { $in: objectIds } })
            .sort({ createdAt: -1 })
            .lean(),
    ]);
    const map = new Map<string, any>();
    const ensure = (key: string) => {
        if (!map.has(key)) {
            map.set(key, {
                distributionCount: 0,
                distributionCodes: [] as string[],
                distributionStatuses: [] as string[],
                distributedQty: 0,
                shortageQty: 0,
                outstandingQty: 0,
                shortageLines: 0,
                totalWithVat: 0,
                distributedAt: undefined as string | undefined,
                shortages: [] as any[],
            });
        }
        return map.get(key);
    };
    for (const record of records as any[]) {
        const key = String(record.supplyRequestId || '');
        if (!key) continue;
        const summary = ensure(key);
        summary.distributionCount += 1;
        if (record.distributionCode) summary.distributionCodes.push(record.distributionCode);
        summary.distributionStatuses.push(record.status);
        summary.distributedQty += (record.items || []).reduce(
            (s: number, item: any) => s + Number(item.quantityDistributed ?? item.quantity ?? 0),
            0
        );
        summary.shortageQty += (record.items || []).reduce(
            (s: number, item: any) => s + Number(item.quantityShortage || 0),
            0
        );
        summary.totalWithVat += Number(record.totalWithVat || record.totalAmount || 0);
        summary.distributedAt =
            summary.distributedAt || toIso(record.distributedAt || record.confirmedAt || record.createdAt);
    }
    for (const shortage of shortages as any[]) {
        const key = String(shortage.originalSupplyRequestId || '');
        if (!key) continue;
        const summary = ensure(key);
        const outstanding = Math.max(
            0,
            Number(shortage.quantityShortage || 0) - Number(shortage.quantityResolved || 0)
        );
        summary.shortageLines += 1;
        summary.outstandingQty += shortage.status === 'settled' || shortage.status === 'cancelled' ? 0 : outstanding;
        summary.shortages.push({
            materialName: shortage.materialName,
            unit: shortage.unit,
            quantityShortage: Number(shortage.quantityShortage || 0),
            quantityResolved: Number(shortage.quantityResolved || 0),
            outstandingQty: shortage.status === 'settled' || shortage.status === 'cancelled' ? 0 : outstanding,
            status: shortage.status,
            statusLabel: SHORTAGE_STATUS_LABEL[shortage.status] || shortage.status,
        });
    }
    for (const summary of map.values()) {
        summary.distributionCodes = [...new Set(summary.distributionCodes)];
        summary.distributionStatuses = [...new Set(summary.distributionStatuses)];
        summary.totalWithVat = Math.round(summary.totalWithVat);
        summary.distributedQty = Math.round(summary.distributedQty);
        summary.shortageQty = Math.round(summary.shortageQty);
        summary.outstandingQty = Math.round(summary.outstandingQty);
    }
    return map;
};

const itemSummary = (items: any[] = []) => {
    const totalRequested = items.reduce((s, item) => s + Number(item.quantityRequested || 0), 0);
    const totalApproved = items.reduce(
        (s, item) => s + Number(item.quantityApproved ?? item.quantityRequested ?? 0),
        0
    );
    const totalOrdered = items.reduce((s, item) => s + Number(item.quantityOrdered || 0), 0);
    const totalWithVat = items.reduce(
        (s, item) => s + Number(item.totalWithVat || item.totalPrice || item.estimatedTotal || 0),
        0
    );
    return {
        itemCount: items.length,
        totalRequested: Math.round(totalRequested),
        totalApproved: Math.round(totalApproved),
        totalOrdered: Math.round(totalOrdered),
        totalWithVat: Math.round(totalWithVat),
    };
};

const serializeRequestRow = (request: any, linkMap: Map<string, any>, kind: RequestKind): any => {
    const id = toId(request) || '';
    const link = linkMap.get(id) || linkMap.get(String(request.requestCode || ''));
    const items = request.items || [];
    const totals = itemSummary(items);
    return {
        id,
        requestCode: request.requestCode || '(chưa có mã)',
        requestType: request.requestType,
        requestTypeLabel:
            request.requestType === 'supply_request'
                ? 'Đề xuất cấp'
                : request.requestType === 'technical_purchase'
                  ? 'Đề nghị mua kỹ thuật'
                  : 'Đề xuất mua',
        status: request.status,
        statusLabel: REQUEST_STATUS_LABEL[request.status] || request.status,
        plantName: plantName(request.plantId),
        fromPlantName: plantName(request.fromPlantId),
        toPlantName: plantName(request.toPlantId),
        requestedBy: personName(request.requestedBy) || request.requesterName,
        approvedBy: personName(request.approvedBy),
        approvedAt: toIso(request.approvedAt),
        rejectedReason: request.rejectedReason,
        note: request.note,
        createdAt: toIso(request.createdAt),
        requestDate: toIso(request.requestDate),
        ageDays: daysBetween(request.createdAt),
        ...totals,
        totalWithVat: Math.round(Number(request.totalWithVat || request.totalEstimated || totals.totalWithVat || 0)),
        items: items.slice(0, 12).map((item: any) => ({
            materialId: toId(item.materialId),
            materialName: item.materialName || item.materialId?.name || 'Vật tư',
            unit: item.unit || item.materialId?.unit || '',
            quantityRequested: Number(item.quantityRequested || 0),
            quantityApproved: item.quantityApproved != null ? Number(item.quantityApproved) : undefined,
            quantityOrdered: item.quantityOrdered != null ? Number(item.quantityOrdered) : undefined,
            quantityReceived: item.quantityReceived != null ? Number(item.quantityReceived) : undefined,
            unitPrice: item.unitPrice != null ? Number(item.unitPrice) : undefined,
            totalWithVat: Math.round(Number(item.totalWithVat || item.totalPrice || item.estimatedTotal || 0)),
            supplierName: item.supplierName,
            proposedBy: item.proposedBy,
            purpose: item.purpose,
            catalogStatus: item.catalogStatus,
            note: item.note,
        })),
        ...(kind === 'supply'
            ? {
                  distribution: link || {
                      distributionCount: 0,
                      distributionCodes: [],
                      distributedQty: 0,
                      shortageQty: 0,
                      outstandingQty: 0,
                      shortageLines: 0,
                      shortages: [],
                  },
              }
            : {
                  orders: link || {
                      orderCount: 0,
                      orderCodes: [],
                      statuses: [],
                      orderedQty: 0,
                      receivedQty: 0,
                      missingQty: 0,
                      totalWithVat: 0,
                  },
              }),
    };
};

const rowsFor = async (args: RequestArgs, defaultKind: RequestKind, maxLimit = 200) => {
    const data = await fetchRequests(args, defaultKind, maxLimit);
    const kind = data.kind === 'supply' ? 'supply' : (data.kind as RequestKind);
    const linkMap = kind === 'supply' ? await buildSupplyLinks(data.docs) : await buildPurchaseLinks(data.docs);
    const rows: any[] = data.docs.map((request) => serializeRequestRow(request, linkMap, kind));
    return { ...data, rows, kind };
};

const groupTop = <T extends Record<string, any>>(
    rows: T[],
    keyFn: (row: T) => string | undefined,
    valueFn?: (row: T) => number
) => {
    const map = new Map<string, { label: string; count: number; value: number }>();
    for (const row of rows) {
        const label = keyFn(row) || 'Chưa rõ';
        const item = map.get(label) || { label, count: 0, value: 0 };
        item.count += 1;
        item.value += valueFn?.(row) ?? 0;
        map.set(label, item);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.value - a.value).slice(0, 10);
};

const topMaterials = (rows: any[]) => {
    const map = new Map<string, any>();
    for (const row of rows) {
        for (const item of row.items || []) {
            const key = normalize(item.materialName);
            if (!key) continue;
            const current = map.get(key) || {
                materialName: item.materialName,
                unit: item.unit,
                requestCount: 0,
                quantityRequested: 0,
                quantityApproved: 0,
                quantityOrdered: 0,
                totalWithVat: 0,
                requestCodes: [] as string[],
            };
            current.requestCount += 1;
            current.quantityRequested += Number(item.quantityRequested || 0);
            current.quantityApproved += Number(item.quantityApproved ?? item.quantityRequested ?? 0);
            current.quantityOrdered += Number(item.quantityOrdered || 0);
            current.totalWithVat += Number(item.totalWithVat || 0);
            current.requestCodes.push(row.requestCode);
            map.set(key, current);
        }
    }
    return [...map.values()]
        .map((m) => ({
            ...m,
            quantityRequested: Math.round(m.quantityRequested),
            quantityApproved: Math.round(m.quantityApproved),
            quantityOrdered: Math.round(m.quantityOrdered),
            totalWithVat: Math.round(m.totalWithVat),
            requestCodes: [...new Set(m.requestCodes)].slice(0, 8),
        }))
        .sort(
            (a, b) =>
                b.requestCount - a.requestCount ||
                b.quantityRequested - a.quantityRequested ||
                b.totalWithVat - a.totalWithVat
        )
        .slice(0, 12);
};

export const listMaterialRequests = async (args: RequestArgs & { kind: RequestKind }) => {
    const data = await rowsFor(args, args.kind, 80);
    const rows = data.rows.slice(0, clampLimit(args.limit, 30));
    return {
        kind: data.kind === 'supply' ? 'supply' : 'purchase',
        title: data.kind === 'supply' ? 'Phiếu đề xuất cấp vật tư' : 'Phiếu đề xuất mua vật tư',
        periodLabel: data.periodLabel,
        total: data.total,
        rows,
        summary: {
            totalValue: rows.reduce((s, row) => s + Number(row.totalWithVat || 0), 0),
            byStatus: groupTop(rows, (row) => row.statusLabel),
            byPlant: groupTop(
                rows,
                (row) => row.fromPlantName || row.plantName,
                (row) => Number(row.totalWithVat || 0)
            ),
            topMaterials: topMaterials(rows).slice(0, 8),
        },
    };
};

export const analyzeMaterialRequests = async (args: RequestArgs & { kind: RequestKind }) => {
    const data = await rowsFor({ ...args, limit: 1000 }, args.kind, 1000);
    const rows = data.rows;
    const staleDays = Number(args.staleDays || 7);
    const oldestPending = rows
        .filter((row) => row.status === 'pending' || row.status === 'draft')
        .sort((a, b) => b.ageDays - a.ageDays)
        .slice(0, 8);
    const largest = [...rows].sort((a, b) => Number(b.totalWithVat || 0) - Number(a.totalWithVat || 0)).slice(0, 8);
    const approvedWithoutNextStep =
        data.kind === 'supply'
            ? rows.filter((row) => row.status === 'approved' && !row.distribution?.distributionCount)
            : rows.filter((row) => ['approved', 'pending'].includes(row.status) && !row.orders?.orderCount);
    const staleApproved = approvedWithoutNextStep.filter((row) => row.ageDays >= staleDays).slice(0, 8);
    const shortages =
        data.kind === 'supply'
            ? rows
                  .filter((row) => Number(row.distribution?.outstandingQty || 0) > 0)
                  .sort(
                      (a, b) =>
                          Number(b.distribution?.outstandingQty || 0) - Number(a.distribution?.outstandingQty || 0)
                  )
                  .slice(0, 8)
            : rows
                  .filter((row) => Number(row.orders?.missingQty || 0) > 0)
                  .sort((a, b) => Number(b.orders?.missingQty || 0) - Number(a.orders?.missingQty || 0))
                  .slice(0, 8);

    return {
        kind: data.kind === 'supply' ? 'supply' : 'purchase',
        title: data.kind === 'supply' ? 'Phân tích phiếu đề xuất cấp' : 'Phân tích phiếu đề xuất mua',
        periodLabel: data.periodLabel,
        total: data.total,
        totalValue: rows.reduce((s, row) => s + Number(row.totalWithVat || 0), 0),
        byStatus: groupTop(rows, (row) => row.statusLabel),
        byPlant: groupTop(
            rows,
            (row) => row.fromPlantName || row.plantName,
            (row) => Number(row.totalWithVat || 0)
        ),
        byRequester: groupTop(rows, (row) => row.requestedBy),
        topMaterials: topMaterials(rows),
        oldestPending,
        largest,
        approvedWithoutNextStep: approvedWithoutNextStep.slice(0, 8),
        staleApproved,
        shortages,
    };
};

export const requestLifecycle = async (args: RequestArgs) => {
    const code = args.requestCode || args.search;
    if (!code) {
        return { found: 0, request: null, message: 'Cần mã phiếu YC-/DX-/KT- để xem vòng đời.' };
    }
    const kind: RequestKind = normalize(code).startsWith('yc')
        ? 'supply'
        : normalize(code).startsWith('kt')
          ? 'technical'
          : 'purchase_all';
    const data = await rowsFor({ ...args, search: code, period: 'all', limit: 5, kind }, kind, 5);
    const request = data.rows[0];
    if (!request) return { found: 0, request: null, message: `Không tìm thấy phiếu ${code}.` };

    const timeline = [
        { label: 'Tạo phiếu', at: request.createdAt, by: request.requestedBy, status: 'done' },
        request.approvedAt
            ? {
                  label: request.status === 'rejected' ? 'Từ chối' : 'Duyệt phiếu',
                  at: request.approvedAt,
                  by: request.approvedBy,
                  status: request.status === 'rejected' ? 'blocked' : 'done',
              }
            : {
                  label: 'Chờ duyệt',
                  at: undefined,
                  by: undefined,
                  status: ['draft', 'pending'].includes(request.status) ? 'current' : 'pending',
              },
    ];
    if (request.requestType === 'supply_request') {
        if (request.distribution?.distributionCount) {
            timeline.push({
                label: 'Cấp phát',
                at: request.distribution.distributedAt,
                by: undefined,
                status: Number(request.distribution.outstandingQty || 0) > 0 ? 'warning' : 'done',
            });
        } else {
            timeline.push({
                label: 'Chưa có phiếu cấp phát',
                at: undefined,
                by: undefined,
                status: request.status === 'approved' ? 'current' : 'pending',
            });
        }
        if (request.distribution?.shortageLines) {
            timeline.push({
                label: 'Xử lý thiếu hụt',
                at: undefined,
                by: undefined,
                status: Number(request.distribution.outstandingQty || 0) > 0 ? 'warning' : 'done',
            });
        }
    } else {
        if (request.orders?.orderCount) {
            timeline.push({
                label: `Lên đơn mua ${request.orders.orderCodes.join(', ')}`,
                at: request.orders.firstOrderedAt,
                by: undefined,
                status: 'done',
            });
            timeline.push({
                label: 'Nhận hàng',
                at: request.orders.lastReceivedAt,
                by: undefined,
                status:
                    Number(request.orders.missingQty || 0) > 0
                        ? 'warning'
                        : request.orders.lastReceivedAt
                          ? 'done'
                          : 'current',
            });
        } else {
            timeline.push({
                label: 'Chưa lên đơn mua',
                at: undefined,
                by: undefined,
                status: ['approved', 'pending'].includes(request.status) ? 'current' : 'pending',
            });
        }
    }
    return { found: data.rows.length, request, timeline };
};

export const requestBacklog = async (args: RequestArgs = {}) => {
    const [supply, purchase] = await Promise.all([
        analyzeMaterialRequests({ ...args, kind: 'supply', period: args.period || 'all', limit: 1000 }),
        analyzeMaterialRequests({ ...args, kind: 'purchase_all', period: args.period || 'all', limit: 1000 }),
    ]);
    const cards = [
        {
            key: 'supplyPending',
            label: 'YC cấp chờ xử lý',
            count: supply.byStatus.find((x) => x.label === 'Chờ duyệt')?.count || 0,
        },
        {
            key: 'supplyApprovedNoDistribution',
            label: 'YC đã duyệt chưa cấp',
            count: supply.approvedWithoutNextStep.length,
        },
        {
            key: 'supplyOutstandingShortage',
            label: 'YC còn thiếu vật tư',
            count: supply.shortages.length,
            quantity: supply.shortages.reduce(
                (s: number, row: any) => s + Number(row.distribution?.outstandingQty || 0),
                0
            ),
        },
        { key: 'purchasePending', label: 'DX mua chờ duyệt/nháp', count: purchase.oldestPending.length },
        { key: 'purchaseApprovedNoOrder', label: 'DX chưa lên đơn', count: purchase.approvedWithoutNextStep.length },
        {
            key: 'purchaseMissingReceipt',
            label: 'DX/PO chưa nhận đủ',
            count: purchase.shortages.length,
            quantity: purchase.shortages.reduce((s: number, row: any) => s + Number(row.orders?.missingQty || 0), 0),
        },
    ];
    return {
        periodLabel: args.period && args.period !== 'all' ? periodRange(args.period).label : 'toàn bộ thời gian',
        cards,
        supply,
        purchase,
    };
};

export const requestRiskAnalysis = async (args: RequestArgs = {}) => {
    const backlog = await requestBacklog(args);
    const risks: any[] = [];
    for (const row of backlog.supply.oldestPending.slice(0, 5)) {
        if (row.ageDays >= 2) {
            risks.push({
                severity: row.ageDays >= 7 ? 'high' : 'medium',
                title: `Phiếu cấp ${row.requestCode} chờ ${row.ageDays} ngày`,
                module: 'Đề xuất cấp',
                requestCode: row.requestCode,
                plantName: row.fromPlantName,
                action: 'Duyệt hoặc từ chối để cơ sở biết kế hoạch nhận vật tư.',
            });
        }
    }
    for (const row of backlog.supply.shortages.slice(0, 5)) {
        risks.push({
            severity: Number(row.distribution?.outstandingQty || 0) > 50 ? 'high' : 'medium',
            title: `Phiếu cấp ${row.requestCode} còn thiếu ${row.distribution?.outstandingQty || 0} đơn vị`,
            module: 'Thiếu hụt cấp phát',
            requestCode: row.requestCode,
            plantName: row.fromPlantName,
            action: 'Kiểm tra tồn kho, tạo cấp bù hoặc chuyển sang đề xuất mua nếu kho không đủ.',
        });
    }
    for (const row of backlog.purchase.approvedWithoutNextStep.slice(0, 5)) {
        risks.push({
            severity: row.ageDays >= 7 ? 'high' : 'medium',
            title: `Phiếu mua ${row.requestCode} chưa lên đơn`,
            module: 'Đề xuất mua',
            requestCode: row.requestCode,
            plantName: row.plantName,
            action: 'Gộp phiếu hoặc tạo PO để tránh trễ cung ứng.',
        });
    }
    for (const row of backlog.purchase.shortages.slice(0, 5)) {
        risks.push({
            severity: Number(row.orders?.missingQty || 0) > 50 ? 'high' : 'medium',
            title: `Phiếu mua ${row.requestCode} chưa nhận đủ ${row.orders?.missingQty || 0} đơn vị`,
            module: 'Đơn mua',
            requestCode: row.requestCode,
            plantName: row.plantName,
            action: `Theo dõi PO ${row.orders?.orderCodes?.join(', ') || ''} và thúc nhà cung cấp.`,
        });
    }
    return {
        periodLabel: backlog.periodLabel,
        riskCount: risks.length,
        risks: risks.slice(0, 12),
        backlogCards: backlog.cards,
    };
};
