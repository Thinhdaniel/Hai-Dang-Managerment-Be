import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { z } from 'zod';
import { subDays } from 'date-fns';
import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import Plant from '@/models/Plant';
import Brand from '@/models/Brand';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { AT_PLANT_RADIUS_M, MAX_ACCURACY_M } from '@/constant/mislocation';
import { buildSearchRegex } from '@/utils/search';
import { serializeAsset } from '@/utils/serializers';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { AI_FEATURES, ASSET_SEARCH_TIERS } from '@/constant/aiModels';
import customResponse from '@/utils/response';

// ===== Nhãn / từ vựng =====
const STATUS_LABEL: Record<string, string> = {
    [ASSET_STATUS.ACTIVE]: 'Hoạt động',
    [ASSET_STATUS.MAINTENANCE]: 'Bảo trì',
    [ASSET_STATUS.BROKEN]: 'Lỗi / hỏng',
    [ASSET_STATUS.BORROWING]: 'Đang mượn',
    [ASSET_STATUS.STORAGE]: 'Tồn kho',
    [ASSET_STATUS.RETURNED_TO_PARTNER]: 'Đã trả đối tác',
};
const OWNERSHIP_LABEL: Record<string, string> = {
    [ASSET_OWNERSHIP_TYPE.OWNED]: 'Máy Hải Đăng',
    [ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED]: 'Máy mượn đối tác',
    [ASSET_OWNERSHIP_TYPE.RENTAL]: 'Máy thuê',
};
const VALID_STATUS = new Set<string>(Object.values(ASSET_STATUS));
const VALID_OWNERSHIP = new Set<string>(Object.values(ASSET_OWNERSHIP_TYPE));
const VALID_FLAGS = new Set(['overdue_maintenance', 'mislocated', 'no_qr', 'not_scanned']);

const normalize = (value?: string) =>
    (value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

const resolveByName = (candidates: { id: string; name: string }[], rawName?: string) => {
    const target = normalize(rawName);
    if (!target) return undefined;
    return (
        candidates.find((c) => normalize(c.name) === target) ||
        candidates.find((c) => {
            const n = normalize(c.name);
            return n && (n.includes(target) || target.includes(n));
        })
    );
};

// ===== Plan schema (AI sinh ra, validate cứng) =====
const planSchema = z
    .object({
        intent: z.enum(['list', 'count', 'aggregate', 'rank', 'answer', 'transfer_draft']).default('list'),
        // Chỉ dùng khi intent=transfer_draft: máy cần chuyển + cơ sở đích (AI soạn, người chốt).
        transfer: z
            .object({
                machineRefs: z.array(z.string()).nullish(),
                toPlantName: z.string().nullish(),
            })
            .nullish(),
        filters: z
            .object({
                search: z.string().max(200).nullish(),
                status: z.array(z.string()).nullish(),
                ownershipType: z.array(z.string()).nullish(),
                plantName: z.string().nullish(),
                brandName: z.string().nullish(),
                area: z.string().nullish(),
                purchaseFrom: z.string().nullish(),
                purchaseTo: z.string().nullish(),
                priceMin: z.number().nullish(),
                priceMax: z.number().nullish(),
                flags: z.array(z.string()).nullish(),
                notScannedDays: z.number().nullish(),
            })
            .default({}),
        aggregate: z
            .enum(['count', 'sum_value', 'breakdown_by_status', 'breakdown_by_plant', 'top_broken'])
            .nullish(),
        limit: z.number().nullish(),
        followups: z.array(z.string()).nullish(),
    })
    .passthrough();

type Plan = z.infer<typeof planSchema>;

const buildPlanSystemPrompt = (plantNames: string[], brandNames: string[], areas: string[]) =>
    [
        'Ban la bo lap ke hoach truy van cho tro ly quan ly may moc cua cong ty may.',
        'Doc TOAN BO hoi thoai (gom cau truoc) va tra ve DUY NHAT 1 JSON mo ta truy van can chay. Khong giai thich ngoai JSON.',
        'Khi nguoi dung hoi noi tiep ("chi loai 1 kim thoi"), hay GOP voi bo loc da hieu o luot truoc.',
        '',
        'Schema JSON:',
        '{',
        '  "intent": "list" | "count" | "aggregate" | "rank" | "answer" | "transfer_draft",',
        '  "transfer": { "machineRefs": string[], "toPlantName": string|null } | null,  // chi khi intent=transfer_draft',
        '  "filters": {',
        '    "search": string|null,            // ten/ma/serial/loai/model may',
        '    "status": string[]|null,          // ma trang thai',
        '    "ownershipType": string[]|null,   // ma nguon goc',
        '    "plantName": string|null, "brandName": string|null, "area": string|null,',
        '    "purchaseFrom": "YYYY-MM-DD"|null, "purchaseTo": "YYYY-MM-DD"|null,',
        '    "priceMin": number|null, "priceMax": number|null,',
        '    "flags": string[]|null,           // co nghiep vu',
        '    "notScannedDays": number|null     // dung kem flag not_scanned',
        '  },',
        '  "aggregate": "count"|"sum_value"|"breakdown_by_status"|"breakdown_by_plant"|"top_broken"|null,',
        '  "limit": number|null,',
        '  "followups": string[]              // 2-3 cau hoi goi y tiep theo',
        '}',
        '',
        `Ma trang thai: ${Object.entries(STATUS_LABEL)
            .map(([k, v]) => `"${k}"=${v}`)
            .join(', ')}.`,
        `Ma nguon goc: ${Object.entries(OWNERSHIP_LABEL)
            .map(([k, v]) => `"${k}"=${v}`)
            .join(', ')}.`,
        'Co nghiep vu (flags): "overdue_maintenance"=may qua han bao tri, "mislocated"=may lech vi tri GPS so voi co so, "no_qr"=may chua co tem QR, "not_scanned"=lau chua quet QR (kem notScannedDays).',
        'Khi hoi "bao nhieu/co may cai" => intent "count". "top/nhieu nhat/xep hang" => intent "rank" + aggregate "top_broken". "tong gia tri" => aggregate "sum_value". "phan theo trang thai/co so" => breakdown_*.',
        'Khi nguoi dung muon DIEU CHUYEN / chuyen / dieu may sang co so khac => intent "transfer_draft": dua TAT CA ma may/serial nhac den vao transfer.machineRefs (mang chuoi), co so dich vao transfer.toPlantName. Chi SOAN, KHONG tao lenh.',
        '',
        plantNames.length ? `Co so hien co: ${plantNames.join(', ')}.` : '',
        brandNames.length ? `Hang hien co: ${brandNames.join(', ')}.` : '',
        areas.length ? `Mot so khu vuc: ${areas.slice(0, 30).join(', ')}.` : '',
        '',
        'Quy tac: chi dung ma/ten co trong danh sach; khong chac thi de null; KHONG bia gia tri. Tra JSON hop le, khong markdown.',
    ]
        .filter(Boolean)
        .join('\n');

// ===== Executor (chay tren DB that) =====
const getOverdueMaintenanceAssetIds = async () => {
    const threshold = subDays(new Date(), 7);
    const tickets = await Maintenance.find({
        isDeleted: { $ne: true },
        status: { $in: ['pending', 'in_progress', 'overdue'] },
        createdAt: { $lt: threshold },
    })
        .select('assetId assetIds')
        .lean();
    const ids = new Set<string>();
    tickets.forEach((t: any) => {
        if (t.assetId) ids.add(String(t.assetId));
        (t.assetIds || []).forEach((a: any) => ids.add(String(a)));
    });
    return [...ids];
};

const buildAssetQuery = async (filters: Plan['filters'], plantId?: string, brandId?: string) => {
    const and: Record<string, any>[] = [{ isDeleted: { $ne: true } }];

    if (filters.search) {
        // Tách từng từ khoá -> mỗi từ phải khớp ở 1 trường nào đó (AND theo từ). Tránh đòi cụm liền mạch.
        const tokens = String(filters.search).split(/\s+/).map((t) => t.trim()).filter(Boolean);
        for (const tok of tokens) {
            const rx = buildSearchRegex(tok);
            if (rx) and.push({ $or: [{ name: rx }, { machineCode: rx }, { serial: rx }, { type: rx }, { model: rx }] });
        }
    }
    const statuses = (filters.status || []).filter((s) => VALID_STATUS.has(s));
    if (statuses.length) and.push({ status: { $in: statuses } });
    const owns = (filters.ownershipType || []).filter((s) => VALID_OWNERSHIP.has(s));
    if (owns.length) and.push({ ownershipType: { $in: owns } });
    if (plantId) and.push({ plantId: new mongoose.Types.ObjectId(plantId) });
    if (brandId) and.push({ brandId: new mongoose.Types.ObjectId(brandId) });
    if (filters.area) {
        const r = buildSearchRegex(filters.area, { flexibleWhitespace: true });
        if (r) and.push({ area: r });
    }
    if (filters.purchaseFrom || filters.purchaseTo) {
        const pd: Record<string, Date> = {};
        if (filters.purchaseFrom) pd.$gte = new Date(filters.purchaseFrom);
        if (filters.purchaseTo) pd.$lte = new Date(`${filters.purchaseTo}T23:59:59.999Z`);
        and.push({ purchaseDate: pd });
    }
    if (filters.priceMin != null || filters.priceMax != null) {
        const pp: Record<string, number> = {};
        if (filters.priceMin != null) pp.$gte = Number(filters.priceMin);
        if (filters.priceMax != null) pp.$lte = Number(filters.priceMax);
        and.push({ purchasePrice: pp });
    }

    const flags = (filters.flags || []).filter((f) => VALID_FLAGS.has(f));
    if (flags.includes('no_qr')) and.push({ $or: [{ publicId: { $exists: false } }, { publicId: null }, { publicId: '' }] });
    if (flags.includes('not_scanned')) {
        const days = Number(filters.notScannedDays) > 0 ? Number(filters.notScannedDays) : 30;
        and.push({
            $or: [{ 'lastSeen.scannedAt': { $exists: false } }, { 'lastSeen.scannedAt': { $lt: subDays(new Date(), days) } }],
        });
    }
    if (flags.includes('mislocated')) {
        and.push({
            'lastSeen.plantId': { $ne: null },
            'lastSeen.distanceM': { $lte: AT_PLANT_RADIUS_M },
            'lastSeen.accuracy': { $lte: MAX_ACCURACY_M },
            $expr: { $ne: ['$lastSeen.plantId', '$plantId'] },
        });
    }
    if (flags.includes('overdue_maintenance')) {
        const overdueIds = await getOverdueMaintenanceAssetIds();
        and.push({
            $or: [
                { nextMaintenanceDate: { $lt: new Date() } },
                { _id: { $in: overdueIds.map((id) => new mongoose.Types.ObjectId(id)) } },
            ],
        });
    }

    return and.length === 1 ? and[0] : { $and: and };
};

const compactItem = (asset: any) => {
    const a = serializeAsset(asset);
    return {
        id: a.id,
        machineCode: a.machineCode,
        name: a.name,
        status: a.status,
        statusLabel: a.status ? STATUS_LABEL[a.status] : undefined,
        plantName: a.plant?.name,
        brandName: a.brand?.name,
        area: a.area,
        purchasePrice: a.purchasePrice,
        mislocated: Boolean(a.locationMismatch?.mismatch),
    };
};

const executePlan = async (plan: Plan, plantId?: string, brandId?: string) => {
    const query = await buildAssetQuery(plan.filters, plantId, brandId);
    const limit = Math.min(Math.max(Number(plan.limit) || 12, 1), 50);

    const aggregates: Record<string, any> = {};

    if (plan.aggregate === 'sum_value') {
        const [row] = await Asset.aggregate([
            { $match: query },
            { $group: { _id: null, count: { $sum: 1 }, totalValue: { $sum: { $ifNull: ['$purchasePrice', 0] } } } },
        ]);
        aggregates.totalValue = row?.totalValue ?? 0;
    } else if (plan.aggregate === 'breakdown_by_status') {
        const rows = await Asset.aggregate([
            { $match: query },
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        aggregates.breakdown = rows.map((r: any) => ({ key: r._id, label: STATUS_LABEL[r._id] || r._id, count: r.count }));
    } else if (plan.aggregate === 'breakdown_by_plant') {
        const rows = await Asset.aggregate([
            { $match: query },
            { $group: { _id: '$plantId', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $lookup: { from: 'plants', localField: '_id', foreignField: '_id', as: 'plant' } },
            { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
        ]);
        aggregates.breakdown = rows.map((r: any) => ({ key: String(r._id), label: r.plant?.name || 'Chưa gán cơ sở', count: r.count }));
    } else if (plan.aggregate === 'top_broken' || plan.intent === 'rank') {
        const scopeIds = await Asset.find(query).select('_id').lean();
        const idSet = scopeIds.map((d: any) => d._id);
        const rows = await Maintenance.aggregate([
            { $match: { isDeleted: { $ne: true }, assetId: { $in: idSet } } },
            { $group: { _id: '$assetId', count: { $sum: 1 }, lastDate: { $max: '$createdAt' } } },
            { $sort: { count: -1, lastDate: -1 } },
            { $limit: limit },
            { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'asset' } },
            { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
            { $lookup: { from: 'plants', localField: 'asset.plantId', foreignField: '_id', as: 'plant' } },
            { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
        ]);
        aggregates.topBroken = rows.map((r: any) => ({
            id: String(r._id),
            machineCode: r.asset?.machineCode,
            name: r.asset?.name,
            plantName: r.plant?.name,
            count: r.count,
        }));
    }

    const count = await Asset.countDocuments(query);
    const docs = await Asset.find(query).sort({ updatedAt: -1 }).limit(limit).populate('brandId').populate('plantId').lean();
    const items = docs.map(compactItem);

    return { count, items, aggregates };
};

// ===== Dien giai ket qua that thanh cau tra loi =====
const buildResultContext = (count: number, items: any[], aggregates: Record<string, any>) => {
    const lines: string[] = [`Tong so may khop: ${count}.`];
    if (aggregates.totalValue != null) lines.push(`Tong gia tri: ${Number(aggregates.totalValue).toLocaleString('vi-VN')} d.`);
    if (aggregates.breakdown) lines.push('Phan ra: ' + aggregates.breakdown.map((b: any) => `${b.label}=${b.count}`).join(', '));
    if (aggregates.topBroken) lines.push('Top hong nhieu: ' + aggregates.topBroken.map((t: any) => `${t.machineCode || t.name} (${t.count} lan)`).join('; '));
    if (items.length) {
        lines.push('Mot so may tieu bieu:');
        items.slice(0, 8).forEach((it) => lines.push(`- ${it.machineCode || ''} ${it.name || ''} [${it.statusLabel || ''}] @ ${it.plantName || ''}`));
    }
    return lines.join('\n');
};

const generateAnswer = async (question: string, context: string) => {
    const result = await aiProviderService.generateText({
        feature: AI_FEATURES.ASSET_ANSWER,
        temperature: 0.1,
        maxTokens: 300,
        messages: [
            {
                role: 'system',
                content: [
                    'Ban la tro ly quan ly may moc. Tra loi DUNG TRONG TAM cau hoi, ngan gon 1-3 cau tieng Viet.',
                    'CHI dua tren danh sach ket qua duoc cung cap. TUYET DOI khong bia ten may/con so khong co trong du lieu.',
                    'KHONG tu tinh toan hay nhac lai tong so/tien (he thong da hien rieng). Neu khong co ket qua, noi ro la khong tim thay.',
                ].join(' '),
            },
            { role: 'user', content: `Cau hoi: ${question}\n\nKet qua thuc te tu he thong:\n${context}` },
        ],
    });
    return result.content.trim();
};

const fallbackAnswer = (count: number, aggregates: Record<string, any>) => {
    if (aggregates.totalValue != null) return `Tìm thấy ${count} máy, tổng giá trị ${Number(aggregates.totalValue).toLocaleString('vi-VN')}đ.`;
    if (aggregates.topBroken) return `Top máy hỏng nhiều nhất: ${aggregates.topBroken.map((t: any) => `${t.machineCode || t.name} (${t.count} lần)`).join(', ')}.`;
    if (aggregates.breakdown) return `Phân bổ: ${aggregates.breakdown.map((b: any) => `${b.label} ${b.count}`).join(', ')}.`;
    return `Tìm thấy ${count} máy khớp yêu cầu của bạn.`;
};

const DEFAULT_FOLLOWUPS = ['Máy nào quá hạn bảo trì?', 'Top 5 máy hỏng nhiều nhất', 'Máy nào lệch vị trí GPS?'];

// Router model thông minh (không tốn call AI): phân loại độ phức tạp câu hỏi -> chọn tier model.
const HEAVY_SIGNALS = [
    'phan tich', 'so sanh', 'tai sao', 'vi sao', 'danh gia', 'du doan', 'xu huong',
    'khuyen nghi', 'tu van', 'de xuat', 'toi uu', 'co nen', 'nen lam', 'lam sao',
];
const LIGHT_SIGNALS = ['liet ke', 'danh sach', 'co nhung may nao', 'tim ', 'dem ', 'bao nhieu', 'co may cai', 'may nao'];

const classifyTier = (question: string): keyof typeof ASSET_SEARCH_TIERS => {
    const t = normalize(question);
    if (HEAVY_SIGNALS.some((k) => t.includes(k))) return 'heavy';
    const words = t.split(' ').filter(Boolean).length;
    if (words <= 12 && LIGHT_SIGNALS.some((k) => t.includes(k))) return 'light';
    return 'standard';
};

export type AssistantMessage = { role: 'user' | 'assistant'; content: string };

// Tool truy vấn máy cho trợ lý agentic: nhận filter (tên cơ sở/hãng), tự resolve + chạy executor thật.
export const assetQueryTool = async (args: {
    search?: string;
    status?: string[];
    ownershipType?: string[];
    plantName?: string;
    brandName?: string;
    area?: string;
    flags?: string[];
    aggregate?: 'count' | 'sum_value' | 'breakdown_by_status' | 'breakdown_by_plant';
    limit?: number;
}) => {
    const [plantDocs, brandDocs] = await Promise.all([
        Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
        Brand.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
    ]);
    const plants = plantDocs.map((d: any) => ({ id: String(d._id), name: String(d.name ?? '') }));
    const brands = brandDocs.map((d: any) => ({ id: String(d._id), name: String(d.name ?? '') }));
    const matchedPlant = resolveByName(plants, args.plantName);
    const matchedBrand = resolveByName(brands, args.brandName);

    const plan = {
        intent: args.aggregate ? 'aggregate' : 'list',
        filters: {
            status: args.status,
            ownershipType: args.ownershipType,
            area: args.area,
            search: args.search,
            flags: args.flags,
        },
        aggregate: args.aggregate,
        limit: args.limit,
    } as Plan;

    const exec = await executePlan(plan, matchedPlant?.id, matchedBrand?.id);
    return {
        count: exec.count,
        items: exec.items,
        aggregates: exec.aggregates,
        appliedFilters: {
            ...plan.filters,
            plantId: matchedPlant?.id,
            plantName: matchedPlant?.name,
            brandId: matchedBrand?.id,
            brandName: matchedBrand?.name,
        },
    };
};

// Soạn nháp lệnh điều chuyển: phân giải máy theo mã/serial/QR + cơ sở đích (KHÔNG tạo lệnh).
const TRANSFER_WARN_STATUSES = new Set(['maintenance', 'broken', 'borrowing']);
const resolveTransferDraft = async (
    refs: string[],
    toPlantName: string | undefined,
    plants: { id: string; name: string }[]
) => {
    const cleaned = [...new Set((refs || []).map((r) => String(r || '').trim()).filter(Boolean))].slice(0, 50);
    const assets: any[] = [];
    const seen = new Set<string>();
    const unresolved: string[] = [];
    for (const ref of cleaned) {
        const exact = new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const doc = await Asset.findOne({
            isDeleted: { $ne: true },
            $or: [{ machineCode: exact }, { serial: exact }, { publicId: exact }],
        })
            .populate('brandId')
            .populate('plantId')
            .lean();
        if (doc) {
            const id = String((doc as any)._id);
            if (!seen.has(id)) {
                seen.add(id);
                assets.push(serializeAsset(doc));
            }
        } else {
            unresolved.push(ref);
        }
    }
    const toPlant = resolveByName(plants, toPlantName);
    const warnings: string[] = [];
    assets.forEach((a) => {
        if (toPlant && String(a.plantId) === toPlant.id) {
            warnings.push(`${a.machineCode || a.name}: đã ở ${toPlant.name}`);
        }
        if (a.status && TRANSFER_WARN_STATUSES.has(a.status)) {
            warnings.push(`${a.machineCode || a.name}: đang ${STATUS_LABEL[a.status] || a.status}`);
        }
    });
    return { assets, toPlantId: toPlant?.id, toPlantName: toPlant?.name, unresolved, warnings };
};

// Soạn nháp lệnh điều chuyển (tái dùng cho cả trợ lý máy lẫn trợ lý vận hành):
// phân giải mã/serial máy + cơ sở đích, trả kèm câu trả lời thân thiện + danh sách máy rút gọn.
// Truyền sẵn `plantsArg` để tránh truy vấn Plant lặp lại nếu nơi gọi đã có.
export const buildTransferDraft = async (
    refs: string[],
    toPlantName?: string,
    plantsArg?: { id: string; name: string }[]
) => {
    const plants =
        plantsArg ??
        (await Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean()).map((d: any) => ({
            id: String(d._id),
            name: String(d.name ?? ''),
        }));
    const cleanRefs = (refs || []).map((r) => String(r || '').trim()).filter(Boolean);
    const draft = await resolveTransferDraft(cleanRefs, toPlantName, plants);
    const found = draft.assets.length;
    const unresolvedNote = draft.unresolved.length
        ? `, ${draft.unresolved.length} mã chưa khớp (${draft.unresolved.join(', ')})`
        : '';
    const answer = !found
        ? `Chưa tìm thấy máy nào khớp${cleanRefs.length ? ` (${cleanRefs.join(', ')})` : ''}. Bạn cho mình mã máy hoặc serial cụ thể nhé.`
        : `Tìm thấy ${found} máy${unresolvedNote}.` +
          (draft.toPlantName
              ? ` Sẵn sàng tạo lệnh điều chuyển sang ${draft.toPlantName} — bấm "Mở form điều chuyển" để xem lại và xác nhận.`
              : ' Bạn muốn chuyển sang cơ sở nào?');
    const items = draft.assets.map((a: any) => ({
        id: a.id,
        machineCode: a.machineCode,
        name: a.name,
        status: a.status,
        statusLabel: a.status ? STATUS_LABEL[a.status] : undefined,
        plantName: a.plant?.name,
        brandName: a.brand?.name,
        area: a.area,
        purchasePrice: a.purchasePrice,
        mislocated: Boolean(a.locationMismatch?.mismatch),
    }));
    return { answer, count: found, items, transferDraft: draft };
};

// ===== Core (tái dùng cho trợ lý toàn cục) =====
export const runAssetAssistant = async (messages: AssistantMessage[]) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';

    const [plantDocs, brandDocs, areaDocs] = await Promise.all([
        Plant.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
        Brand.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
        Asset.distinct('area', { isDeleted: { $ne: true }, area: { $nin: [null, ''] } }),
    ]);
    const plants = plantDocs.map((d: any) => ({ id: String(d._id), name: String(d.name ?? '') }));
    const brands = brandDocs.map((d: any) => ({ id: String(d._id), name: String(d.name ?? '') }));
    const areas = (areaDocs as string[]).filter(Boolean);

    // Auto-switch model theo độ phức tạp câu hỏi cuối -> tiết kiệm quota.
    const tier = classifyTier(lastUser);
    const planFeature = ASSET_SEARCH_TIERS[tier];

    let plan: Plan = { intent: 'list', filters: {} };
    let provider = 'fallback';
    let model: string | undefined;
    try {
        const aiResult = await aiProviderService.generateJson<Record<string, unknown>>({
            feature: planFeature,
            temperature: 0.1,
            maxTokens: 600,
            messages: [
                { role: 'system', content: buildPlanSystemPrompt(plants.map((p) => p.name), brands.map((b) => b.name), areas) },
                ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
        });
        plan = planSchema.parse(aiResult.data);
        provider = aiResult.provider;
        model = aiResult.model;
    } catch {
        // AI lỗi -> plan rỗng, vẫn chạy list theo từ khoá câu hỏi cuối.
        plan = { intent: 'list', filters: { search: lastUser.slice(0, 200) } } as Plan;
    }

    // Dò nhãn/cơ sở: ưu tiên plan, nếu trống thì quét chính câu hỏi (chống AI bỏ sót).
    const qn = normalize(lastUser);
    const matchedPlant =
        resolveByName(plants, plan.filters.plantName ?? undefined) ||
        plants.find((p) => normalize(p.name) && qn.includes(normalize(p.name)));
    const matchedBrand =
        resolveByName(brands, plan.filters.brandName ?? undefined) ||
        brands.find((b) => normalize(b.name) && qn.includes(normalize(b.name)));

    // Gỡ tên nhãn/cơ sở khỏi từ khoá tìm (vd "1 kim hikari" -> "1 kim"), tránh tìm cụm liền mạch ra 0 kết quả.
    if (plan.filters.search) {
        const drop = new Set(
            [matchedBrand?.name, matchedPlant?.name]
                .filter(Boolean)
                .flatMap((n) => normalize(n as string).split(' '))
        );
        const cleaned = normalize(plan.filters.search)
            .split(' ')
            .filter((t) => t && !drop.has(t))
            .join(' ');
        plan.filters.search = cleaned || undefined;
    }

    // Soạn lệnh điều chuyển: phân giải máy + cơ sở đích, trả thẻ hành động cho FE mở form.
    if (plan.intent === 'transfer_draft') {
        const refs = (plan.transfer?.machineRefs ?? []) as string[];
        const toPlantName = plan.transfer?.toPlantName ?? matchedPlant?.name ?? undefined;
        const d = await buildTransferDraft(refs, toPlantName ?? undefined, plants);
        return {
            domain: 'asset' as const,
            answer: d.answer,
            intent: 'transfer_draft',
            count: d.count,
            items: d.items,
            aggregates: {},
            transferDraft: d.transferDraft,
            appliedFilters: {},
            followups: ['Chuyển máy khác sang cơ sở này', 'Tìm máy theo mã/serial', 'Máy nào đang tồn kho?'],
            provider,
            model,
            tier,
        };
    }

    const exec = await executePlan(plan, matchedPlant?.id, matchedBrand?.id);

    // Câu trả lời deterministic làm nền (số liệu luôn đúng). Chỉ dùng AI diễn đạt cho câu LIỆT KÊ.
    let answer = fallbackAnswer(exec.count, exec.aggregates);
    if (plan.intent === 'list' || plan.intent === 'answer') {
        try {
            const ai = await generateAnswer(lastUser, buildResultContext(exec.count, exec.items, exec.aggregates));
            if (ai) answer = ai;
        } catch {
            /* giữ câu deterministic */
        }
    }

    const followups = (plan.followups || []).filter((f) => typeof f === 'string' && f.trim()).slice(0, 3);

    return {
        domain: 'asset' as const,
        answer,
        intent: plan.intent,
        count: exec.count,
        items: exec.items,
        aggregates: exec.aggregates,
        appliedFilters: {
            ...plan.filters,
            plantId: matchedPlant?.id,
            plantName: matchedPlant?.name,
            brandId: matchedBrand?.id,
            brandName: matchedBrand?.name,
        },
        followups: followups.length ? followups : DEFAULT_FOLLOWUPS,
        provider,
        model,
        tier,
    };
};

// ===== HTTP (giữ endpoint cũ /ai/assistant/assets) =====
export const askAssetAssistant = async (req: Request, res: Response) => {
    const data = await runAssetAssistant((req.body.messages ?? []) as AssistantMessage[]);
    return res.status(StatusCodes.OK).json(
        customResponse({ data, message: 'Tro ly da xu ly cau hoi', status: StatusCodes.OK, success: true })
    );
};
