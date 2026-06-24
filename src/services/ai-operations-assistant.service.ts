import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import Material from '@/models/Material';
import InventoryStock from '@/models/InventoryStock';
import DistributionRecord from '@/models/DistributionRecord';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { ASSET_SEARCH_TIERS } from '@/constant/aiModels';
import { runAssetAssistant, type AssistantMessage } from '@/services/ai-asset-assistant.service';
import { computeVarianceData } from '@/services/variance.service';
import customResponse from '@/utils/response';

const normalize = (v?: string) =>
    (v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

// ===== Router domain (heuristic, không tốn call AI) =====
type Domain = 'asset' | 'material' | 'cost';
const COST_SIGNALS = ['chi phi', 'chi tieu', 'ton kem', 'ngan sach', 'gia tri may', 'tien sua', 'tien cap'];
const MATERIAL_SIGNALS = ['vat tu', 'ton kho', 'nguyen lieu', 'cap phat', 'sap het', 'het hang', 'dinh muc', 'kim may', 'chi may', 'dau may', 'vai'];

const classifyDomain = (question: string): Domain => {
    const t = normalize(question);
    if (COST_SIGNALS.some((k) => t.includes(k))) return 'cost';
    if (MATERIAL_SIGNALS.some((k) => t.includes(k))) return 'material';
    return 'asset';
};

const lastUserOf = (messages: AssistantMessage[]) =>
    [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';

// ===== Domain: VẬT TƯ =====
const materialPlanSchema = z
    .object({
        intent: z.enum(['low_stock', 'top_used', 'list']).default('list'),
        search: z.string().max(120).nullish(),
        category: z.string().max(80).nullish(),
        followups: z.array(z.string()).nullish(),
    })
    .passthrough();

const materialItem = (id: string, m: any, badge?: string) => ({
    id: String(id),
    machineCode: m?.code,
    name: m?.name,
    plantName: m?.category,
    statusLabel: badge,
    mislocated: false,
});

const runMaterialAssistant = async (messages: AssistantMessage[], lastUser: string) => {
    const categories = (await Material.distinct('category', { isDeleted: { $ne: true }, category: { $nin: [null, ''] } })) as string[];

    let plan: z.infer<typeof materialPlanSchema> = { intent: 'list' };
    let provider = 'fallback';
    let model: string | undefined;
    try {
        const ai = await aiProviderService.generateJson<Record<string, unknown>>({
            feature: ASSET_SEARCH_TIERS.light,
            temperature: 0.1,
            maxTokens: 400,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Trich xuat truy van danh muc vat tu. Tra ve JSON: {"intent":"low_stock|top_used|list","search":string|null,"category":string|null,"followups":[..]}',
                        'low_stock = vat tu sap het/duoi dinh muc; top_used = vat tu cap phat/tieu thu nhieu; list = liet ke/dem/tim.',
                        categories.length ? `Nhom vat tu: ${categories.slice(0, 40).join(', ')}.` : '',
                    ]
                        .filter(Boolean)
                        .join('\n'),
                },
                ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
        });
        plan = materialPlanSchema.parse(ai.data);
        provider = ai.provider;
        model = ai.model;
    } catch {
        const t = normalize(lastUser);
        plan = {
            intent: t.includes('sap het') || t.includes('het') || t.includes('dinh muc')
                ? 'low_stock'
                : t.includes('cap nhieu') || t.includes('dung nhieu') || t.includes('tieu thu')
                  ? 'top_used'
                  : 'list',
            search: lastUser.slice(0, 120),
        };
    }

    let items: any[] = [];
    let count = 0;

    if (plan.intent === 'low_stock') {
        const rows = await InventoryStock.aggregate([
            { $match: { isDeleted: { $ne: true } } },
            { $group: { _id: '$materialId', stock: { $sum: '$currentStock' } } },
            { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'm' } },
            { $unwind: '$m' },
            { $match: { 'm.isDeleted': { $ne: true }, 'm.trackInventory': { $ne: false }, $expr: { $lte: ['$stock', { $ifNull: ['$m.minStockLevel', 0] }] } } },
            { $sort: { stock: 1 } },
            { $limit: 20 },
        ]);
        count = rows.length;
        items = rows.map((r: any) => materialItem(r._id, r.m, `tồn ${r.stock} ${r.m.unit || ''}`));
    } else if (plan.intent === 'top_used') {
        const rows = await DistributionRecord.aggregate([
            { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] } } },
            { $unwind: '$items' },
            { $group: { _id: '$items.materialId', qty: { $sum: { $ifNull: ['$items.quantity', 0] } }, name: { $first: '$items.materialName' } } },
            { $match: { _id: { $ne: null } } },
            { $sort: { qty: -1 } },
            { $limit: 15 },
            { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'm' } },
            { $unwind: { path: '$m', preserveNullAndEmptyArrays: true } },
        ]);
        count = rows.length;
        items = rows.map((r: any) => materialItem(r._id, { code: r.m?.code, name: r.m?.name || r.name, category: r.m?.category, unit: r.m?.unit }, `cấp ${Math.round(r.qty)} ${r.m?.unit || ''}`));
    } else {
        const filter: Record<string, any> = { isDeleted: { $ne: true }, isActive: { $ne: false } };
        if (plan.search) {
            const rx = new RegExp(plan.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ name: rx }, { code: rx }];
        }
        if (plan.category) filter.category = new RegExp(String(plan.category).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        count = await Material.countDocuments(filter);
        const docs = await Material.find(filter).limit(20).lean();
        items = docs.map((m: any) => materialItem(m._id, m, m.unit));
    }

    // Câu trả lời deterministic (số liệu thật), không để AI bịa.
    const answer =
        plan.intent === 'low_stock'
            ? count
                ? `Có ${count} vật tư đang dưới định mức tồn kho.`
                : 'Hiện không có vật tư nào dưới định mức tồn kho.'
            : plan.intent === 'top_used'
              ? count
                  ? `${count} vật tư được cấp phát nhiều nhất:`
                  : 'Chưa có dữ liệu cấp phát vật tư.'
              : count
                ? `Tìm thấy ${count} vật tư khớp yêu cầu.`
                : 'Không tìm thấy vật tư khớp yêu cầu.';

    return {
        domain: 'material' as const,
        answer,
        intent: plan.intent,
        count,
        items,
        aggregates: {},
        followups: (plan.followups || ['Vật tư nào sắp hết?', 'Vật tư cấp phát nhiều nhất?', 'Tồn kho theo cơ sở?']).slice(0, 3),
        provider,
        model,
        tier: 'light',
    };
};

// ===== Domain: CHI PHÍ (tái dùng variance) =====
const runCostAssistant = async (lastUser: string) => {
    const t = normalize(lastUser);
    const metric =
        t.includes('sua ngoai') || t.includes('sua chua')
            ? 'repair_cost'
            : t.includes('cap phat') || t.includes('vat tu')
              ? 'distribution_cost'
              : t.includes('phieu bao tri') || t.includes('so phieu')
                ? 'maintenance_tickets'
                : 'total_cost';
    const period = t.includes('tuan') ? 'week' : 'month';
    const v = await computeVarianceData(metric, period);
    const driverLine = v.drivers
        .slice(0, 3)
        .map((d) => `${d.label} ${d.delta >= 0 ? '+' : ''}${v.isCost ? `${Math.round(d.delta).toLocaleString('vi-VN')}đ` : d.delta}`)
        .join(', ');

    return {
        domain: 'cost' as const,
        answer: `${v.explanation}${driverLine ? `\n\nĐóng góp chính: ${driverLine}.` : ''}`,
        intent: 'answer',
        count: 0,
        items: [],
        aggregates: { variance: { metricLabel: v.metricLabel, current: v.current, previous: v.previous, deltaPct: v.deltaPct, isCost: v.isCost } },
        followups: ['Cơ sở nào tốn nhất?', 'Chi phí sửa ngoài kỳ này', 'Số phiếu bảo trì thay đổi sao?'],
        provider: v.provider,
    };
};

// ===== HTTP: trợ lý toàn cục =====
export const askOperationsAssistant = async (req: Request, res: Response) => {
    const messages = (req.body.messages ?? []) as AssistantMessage[];
    const lastUser = lastUserOf(messages);
    const domain = classifyDomain(lastUser);

    const data =
        domain === 'cost'
            ? await runCostAssistant(lastUser)
            : domain === 'material'
              ? await runMaterialAssistant(messages, lastUser)
              : await runAssetAssistant(messages);

    return res.status(StatusCodes.OK).json(
        customResponse({ data, message: 'Tro ly da xu ly cau hoi', status: StatusCodes.OK, success: true })
    );
};
