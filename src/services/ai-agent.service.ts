import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import Material from '@/models/Material';
import InventoryStock from '@/models/InventoryStock';
import DistributionRecord from '@/models/DistributionRecord';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { aiProviderService, extractJsonObject } from '@/services/ai/ai-provider.service';
import { ASSET_SEARCH_TIERS } from '@/constant/aiModels';
import { assetQueryTool, type AssistantMessage } from '@/services/ai-asset-assistant.service';
import { computeVarianceData } from '@/services/variance.service';
import { analyzePurchases, listPurchaseOrders, materialUsageByPlant } from '@/services/ai-material-insight.service';
import customResponse from '@/utils/response';

const normalize = (v?: string) =>
    (v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

const HEAVY_SIGNALS = ['phan tich', 'so sanh', 'tai sao', 'vi sao', 'danh gia', 'du doan', 'xu huong', 'khuyen nghi', 'tu van', 'de xuat', 'toi uu', 'co nen'];
const tierFor = (q: string) => (HEAVY_SIGNALS.some((k) => normalize(q).includes(k)) ? ASSET_SEARCH_TIERS.heavy : ASSET_SEARCH_TIERS.standard);

// ===== Tools (đều trả dữ liệu THẬT) =====
const materialItem = (id: string, m: any, badge?: string) => ({
    id: String(id),
    machineCode: m?.code,
    name: m?.name,
    plantName: m?.category,
    statusLabel: badge,
    mislocated: false,
});

const lowStockMaterials = async (limit = 20) => {
    const rows = await InventoryStock.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$materialId', stock: { $sum: '$currentStock' } } },
        { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'm' } },
        { $unwind: '$m' },
        { $match: { 'm.isDeleted': { $ne: true }, 'm.trackInventory': { $ne: false }, $expr: { $lte: ['$stock', { $ifNull: ['$m.minStockLevel', 0] }] } } },
        { $sort: { stock: 1 } },
        { $limit: Math.min(limit, 30) },
    ]);
    return rows.map((r: any) => materialItem(r._id, r.m, `tồn ${r.stock} ${r.m.unit || ''}`));
};

const topUsedMaterials = async (limit = 15) => {
    const rows = await DistributionRecord.aggregate([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['distributed', 'confirmed'] } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.materialId', qty: { $sum: { $ifNull: ['$items.quantity', 0] } }, name: { $first: '$items.materialName' } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { qty: -1 } },
        { $limit: Math.min(limit, 30) },
        { $lookup: { from: 'materials', localField: '_id', foreignField: '_id', as: 'm' } },
        { $unwind: { path: '$m', preserveNullAndEmptyArrays: true } },
    ]);
    return rows.map((r: any) => materialItem(r._id, { code: r.m?.code, name: r.m?.name || r.name, category: r.m?.category, unit: r.m?.unit }, `cấp ${Math.round(r.qty)} ${r.m?.unit || ''}`));
};

const searchMaterials = async (args: { search?: string; category?: string; limit?: number }) => {
    const filter: Record<string, any> = { isDeleted: { $ne: true }, isActive: { $ne: false } };
    if (args.search) {
        const rx = new RegExp(args.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { code: rx }];
    }
    if (args.category) filter.category = new RegExp(String(args.category).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const count = await Material.countDocuments(filter);
    const docs = await Material.find(filter).limit(Math.min(args.limit || 20, 30)).lean();
    return { count, items: docs.map((m: any) => materialItem(m._id, m, m.unit)) };
};

type ToolName =
    | 'search_assets'
    | 'top_broken_assets'
    | 'low_stock_materials'
    | 'top_used_materials'
    | 'search_materials'
    | 'material_usage_by_plant'
    | 'purchase_analysis'
    | 'purchase_orders'
    | 'cost_variance'
    | 'summary_metrics';

type ToolOutcome = {
    ai: any; // gửi lại cho AI (gọn)
    render?: { domain: 'asset' | 'material' | 'cost'; count: number; items: any[]; aggregates: any; appliedFilters?: any };
};

const executeTool = async (name: ToolName, args: any): Promise<ToolOutcome> => {
    switch (name) {
        case 'search_assets': {
            const r = await assetQueryTool(args || {});
            return {
                ai: { count: r.count, sample: r.items.slice(0, 8).map((i: any) => ({ code: i.machineCode, name: i.name, status: i.statusLabel, plant: i.plantName })), aggregates: r.aggregates },
                render: { domain: 'asset', count: r.count, items: r.items, aggregates: r.aggregates, appliedFilters: r.appliedFilters },
            };
        }
        case 'top_broken_assets': {
            const top = await dashboardRepository.getTopBrokenAssets(Math.min(args?.limit || 5, 15));
            const topBroken = top.map((t: any) => ({ id: t.assetId, machineCode: t.machineCode, name: t.assetName, plantName: t.plantName, count: t.count }));
            return { ai: { topBroken }, render: { domain: 'asset', count: topBroken.length, items: [], aggregates: { topBroken } } };
        }
        case 'low_stock_materials': {
            const items = await lowStockMaterials(args?.limit);
            return { ai: { count: items.length, sample: items.slice(0, 8).map((i) => ({ code: i.machineCode, name: i.name, ton: i.statusLabel })) }, render: { domain: 'material', count: items.length, items, aggregates: {} } };
        }
        case 'top_used_materials': {
            const items = await topUsedMaterials(args?.limit);
            return { ai: { count: items.length, sample: items.slice(0, 8).map((i) => ({ code: i.machineCode, name: i.name, cap: i.statusLabel })) }, render: { domain: 'material', count: items.length, items, aggregates: {} } };
        }
        case 'search_materials': {
            const r = await searchMaterials(args || {});
            return { ai: { count: r.count, sample: r.items.slice(0, 8).map((i) => ({ code: i.machineCode, name: i.name })) }, render: { domain: 'material', count: r.count, items: r.items, aggregates: {} } };
        }
        case 'material_usage_by_plant': {
            const u = await materialUsageByPlant(args || {});
            return {
                ai: {
                    period: u.periodLabel,
                    coSo: u.plantName || 'tất cả cơ sở',
                    tongGiaTri: u.totalValue,
                    topVatTu: u.materials.slice(0, 8).map((m) => ({
                        vatTu: m.materialName,
                        soLuong: `${m.totalQty} ${m.unit}`,
                        giaTri: m.totalValue,
                        coSoNhieuNhat: m.plants[0]?.plantName,
                    })),
                },
                render: { domain: 'material', count: u.materials.length, items: [], aggregates: { usageByPlant: u } },
            };
        }
        case 'purchase_analysis': {
            const p = await analyzePurchases(args || {});
            return {
                ai: {
                    ky: p.periodLabel,
                    kyTruoc: p.prevLabel,
                    phanRaTheo: p.groupBy === 'supplier' ? 'nhà cung cấp' : 'vật tư',
                    tongKyNay: p.current,
                    tongKyTruoc: p.previous,
                    deltaPct: p.deltaPct,
                    topYeuTo: p.rows.slice(0, 8).map((r) => ({ ten: r.label, kyNay: r.current, kyTruoc: r.previous, delta: r.delta })),
                },
                render: { domain: 'cost', count: p.rows.length, items: [], aggregates: { purchaseAnalysis: p } },
            };
        }
        case 'purchase_orders': {
            const o = await listPurchaseOrders(args || {});
            return {
                ai: {
                    tongSo: o.count,
                    chiTiet: o.detail,
                    donHang: o.orders.slice(0, 10).map((d: any) => ({
                        ma: d.orderCode,
                        ncc: d.supplierName,
                        coSo: d.plantName,
                        trangThai: d.statusLabel,
                        tongTien: d.totalWithVat,
                        soDongVatTu: d.itemCount,
                        ...(d.items ? { vatTu: d.items.map((it: any) => ({ ten: it.materialName, sl: `${it.quantityOrdered} ${it.unit}`, gia: it.totalWithVat })) } : {}),
                    })),
                },
                render: { domain: 'material', count: o.count, items: [], aggregates: { purchaseOrders: { detail: o.detail, orders: o.orders } } },
            };
        }
        case 'cost_variance': {
            const v = await computeVarianceData(args?.metric, args?.period);
            return {
                ai: { metric: v.metricLabel, kyNay: v.current, kyTruoc: v.previous, deltaPct: v.deltaPct, donVi: v.isCost ? 'VND' : 'phieu', topCoSo: v.drivers.slice(0, 5).map((d) => ({ coSo: d.label, delta: d.delta })) },
                render: { domain: 'cost', count: 0, items: [], aggregates: { variance: { metricLabel: v.metricLabel, current: v.current, previous: v.previous, deltaPct: v.deltaPct, isCost: v.isCost, drivers: v.drivers } } },
            };
        }
        case 'summary_metrics': {
            const s = await dashboardRepository.getSummaryMetrics();
            return { ai: s };
        }
        default:
            return { ai: { error: 'unknown tool' } };
    }
};

// ===== Lưới an toàn: tự định tuyến + trả lời từ số liệu thật khi AI không grounded =====
const fmtVnd = (v: number) => `${Math.round(v || 0).toLocaleString('vi-VN')}đ`;
const detectPeriod = (q: string): 'week' | 'month' => (normalize(q).includes('tuan') ? 'week' : 'month');
const detectMetric = (q: string): string => {
    const n = normalize(q);
    if (n.includes('sua ngoai') || n.includes('sua chua') || n.includes('sua may')) return 'repair_cost';
    if (n.includes('cap phat')) return 'distribution_cost';
    if (n.includes('mua')) return 'purchase_cost';
    if (n.includes('phieu') || n.includes('bao tri')) return 'maintenance_tickets';
    return 'total_cost';
};
const extractOrderCode = (q: string): string | undefined => {
    const m = q.match(/\b[A-Za-z]{1,5}[-_]?\d{3,}[-_\dA-Za-z]*\b/);
    return m ? m[0] : undefined;
};

// Đoán tool đúng từ từ khóa (chỉ cho các mảng dữ liệu rõ ràng — KHÔNG đoán bừa câu hội thoại).
const classifyIntent = (q: string): { tool: ToolName; args: any } | null => {
    const n = normalize(q);
    const code = extractOrderCode(q);
    if (code || n.includes('don hang') || n.includes('don mua') || n.includes('don dat')) {
        return { tool: 'purchase_orders', args: { search: code, period: n.includes('thang') || n.includes('tuan') ? detectPeriod(q) : undefined } };
    }
    if (n.includes('mua') && (n.includes('phan tich') || n.includes('chi tiet') || n.includes('vat tu nao') || n.includes('nha cung cap') || n.includes('ncc') || n.includes('so sanh'))) {
        return { tool: 'purchase_analysis', args: { period: detectPeriod(q), groupBy: n.includes('nha cung cap') || n.includes('ncc') ? 'supplier' : 'material' } };
    }
    if (n.includes('cap phat') || n.includes('su dung nhieu') || n.includes('dung nhieu') || n.includes('cap nhieu') || n.includes('tieu thu') || (n.includes('vat tu') && n.includes('co so'))) {
        return { tool: 'material_usage_by_plant', args: { plantName: q, period: n.includes('thang') || n.includes('tuan') ? detectPeriod(q) : undefined } };
    }
    if (n.includes('sap het') || n.includes('duoi dinh muc') || n.includes('ton kho thap') || n.includes('het hang') || n.includes('thieu hang') || n.includes('can mua them')) {
        return { tool: 'low_stock_materials', args: {} };
    }
    if (n.includes('chi phi') || n.includes('bien dong') || n.includes('chi tieu') || n.includes('ton bao nhieu tien') || n.includes('tieu ton')) {
        return { tool: 'cost_variance', args: { metric: detectMetric(q), period: detectPeriod(q) } };
    }
    if (n.includes('hong') && (n.includes('nhieu') || n.includes('top') || n.includes('hay '))) {
        return { tool: 'top_broken_assets', args: {} };
    }
    if (n.includes('tong quan') || n.includes('tinh hinh chung') || n.includes('tom tat he thong')) {
        return { tool: 'summary_metrics', args: {} };
    }
    return null;
};

// Dựng câu trả lời TỪ SỐ LIỆU THẬT trong render (không để AI bịa). Trả null nếu không có gì để nói.
const buildDeterministicAnswer = (render: ToolOutcome['render']): string | null => {
    if (!render) return null;
    const a = render.aggregates || {};
    if (a.usageByPlant) {
        const u = a.usageByPlant;
        const top = u.materials.slice(0, 3);
        const at = u.plantName ? ` ở ${u.plantName}` : ' (toàn hệ thống)';
        if (!top.length) return `Chưa có dữ liệu cấp phát ${u.periodLabel}${at}.`;
        return (
            `Vật tư cấp phát nhiều nhất ${u.periodLabel}${at}: ` +
            top.map((m: any, i: number) => `${i + 1}. ${m.materialName} ${m.totalQty} ${m.unit} (${fmtVnd(m.totalValue)})`).join('; ') +
            '.'
        );
    }
    if (a.purchaseAnalysis) {
        const p = a.purchaseAnalysis;
        const head = `Chi phí mua vật tư ${p.periodLabel}: ${fmtVnd(p.current)} (${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct}% so ${p.prevLabel} ${fmtVnd(p.previous)}).`;
        const top = p.rows[0];
        if (!top) return head;
        // rows đã sắp theo |delta| -> mô tả yếu tố biến động mạnh nhất (đúng cả khi kỳ này = 0).
        return `${head} Biến động mạnh nhất: ${top.label} (${top.delta >= 0 ? '+' : ''}${fmtVnd(top.delta)}).`;
    }
    if (a.purchaseOrders) {
        const o = a.purchaseOrders;
        if (!o.orders.length) return 'Không tìm thấy đơn hàng nào khớp.';
        if (o.detail && o.orders[0].items) {
            const d = o.orders[0];
            return `Đơn ${d.orderCode} (${d.supplierName}, ${d.statusLabel}): ${d.itemCount} dòng vật tư, tổng ${fmtVnd(d.totalWithVat)}.`;
        }
        return `Có ${render.count} đơn hàng. Gần nhất: ${o.orders.slice(0, 3).map((d: any) => `${d.orderCode} ${fmtVnd(d.totalWithVat)}`).join(', ')}.`;
    }
    if (a.variance) {
        const v = a.variance;
        const top = v.drivers[0];
        const cur = v.isCost ? fmtVnd(v.current) : `${v.current}`;
        return (
            `${v.metricLabel}: ${cur} (${v.deltaPct >= 0 ? '+' : ''}${v.deltaPct}% so kỳ trước).` +
            (top ? ` Chủ yếu ở ${top.label} (${top.delta >= 0 ? '+' : ''}${v.isCost ? fmtVnd(top.delta) : top.delta}).` : '')
        );
    }
    if (a.topBroken?.length) {
        return `Top máy hỏng nhiều nhất: ` + a.topBroken.slice(0, 3).map((t: any, i: number) => `${i + 1}. ${t.machineCode || t.name} (${t.count} lần)`).join('; ') + '.';
    }
    if (render.domain === 'material') return render.count ? `Tìm thấy ${render.count} vật tư phù hợp.` : 'Không có vật tư nào khớp.';
    if (render.domain === 'asset') return render.count ? `Tìm thấy ${render.count} máy phù hợp.` : 'Không có máy nào khớp.';
    return null;
};

const SYSTEM_PROMPT = [
    'Ban la tro ly van hanh cho cong ty may. Phan tich cau hoi roi TU GOI TOOL de lay du lieu THAT, sau do tra loi.',
    'Moi buoc tra ve DUY NHAT 1 JSON, khong markdown:',
    '- Goi tool: {"tool":"ten_tool","args":{...}}',
    '- Tra loi cuoi: {"final":"cau tra loi tieng Viet","followups":["goi y 1","goi y 2"]}',
    'Khi da co du du lieu tu ket qua tool, hay tra {"final":...}. CHI dung con so tu ket qua tool, TUYET DOI khong bia.',
    '',
    'Cac tool:',
    '- search_assets(args): tim/dem/liet ke may. args:{search?, status?:[active|maintenance|broken|borrowing|storage|returned_to_partner], ownershipType?:[owned|partner_borrowed|rental], plantName?, brandName?, area?, flags?:[overdue_maintenance|mislocated|no_qr|not_scanned], aggregate?:count|sum_value|breakdown_by_status|breakdown_by_plant, limit?}',
    '  Luu y: ten loai may o truong "search" (vd "1 kim"), KHONG nhet ten hang vao search (dung brandName).',
    '- top_broken_assets(args:{plantName?,limit?}): may hong nhieu nhat.',
    '- low_stock_materials(args:{limit?}): vat tu duoi dinh muc ton kho.',
    '- top_used_materials(args:{limit?}): vat tu cap phat nhieu nhat (tong, khong chia co so).',
    '- material_usage_by_plant(args:{plantName?, period?:week|month, limit?}): vat tu CAP PHAT nhieu nhat, PHAN RA THEO TUNG CO SO nhan. Dung khi hoi "vat tu nao dung nhieu nhat o cac co so", hoac dung nhieu o 1 co so cu the (truyen plantName).',
    '- search_materials(args:{search?,category?,limit?}): tim vat tu.',
    '- purchase_analysis(args:{period:week|month, groupBy?:material|supplier, limit?}): phan tich CHI TIET chi phi MUA vat tu ky nay vs ky truoc, phan ra theo vat tu (mac dinh) hoac nha cung cap. Dung khi hoi "phan tich chi tiet chi phi mua vat tu", "mua nhieu nhat la vat tu/ncc nao".',
    '- purchase_orders(args:{search?, orderCode?, supplierName?, plantName?, status?:draft|confirmed|ordered|partially_received|received|cancelled, period?:week|month, limit?}): tra cuu DON HANG mua vat tu. Truyen orderCode hoac search (ma don/ten vat tu/ten NCC) de SOI SAU 1 don (tra ve tung dong vat tu). Dung khi hoi ve don hang cu the.',
    '- cost_variance(args:{metric:repair_cost|distribution_cost|purchase_cost|total_cost|maintenance_tickets, period:week|month}): chi phi va bien dong so voi ky truoc, phan ra theo CO SO. "mua vat tu"=purchase_cost, "cap phat"=distribution_cost, "sua ngoai"=repair_cost. (Muon phan ra theo vat tu/NCC thi dung purchase_analysis.)',
    '- summary_metrics(): tong quan toan he thong.',
    '',
    'Chon tool dung muc do: hoi TONG chi phi/bien dong theo co so -> cost_variance; hoi CHI TIET mua theo vat tu/NCC -> purchase_analysis; hoi 1 DON cu the -> purchase_orders; hoi vat tu dung nhieu o cac co so -> material_usage_by_plant.',
].join('\n');

const VALID_TOOLS = new Set<ToolName>([
    'search_assets',
    'top_broken_assets',
    'low_stock_materials',
    'top_used_materials',
    'search_materials',
    'material_usage_by_plant',
    'purchase_analysis',
    'purchase_orders',
    'cost_variance',
    'summary_metrics',
]);
const MAX_TOOL_CALLS = 3;
const MAX_ITERATIONS = 6;

export const askAgentAssistant = async (req: Request, res: Response) => {
    const messages = (req.body.messages ?? []) as AssistantMessage[];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';
    const feature = tierFor(lastUser);

    const convo: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let toolCalls = 0;
    let provider = 'fallback';
    let model: string | undefined;
    let lastRender: ToolOutcome['render'] | undefined;
    let answer = '';

    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
        let parsed: any;
        try {
            const ai = await aiProviderService.generateJson<any>({ feature, temperature: 0.1, maxTokens: 700, messages: convo });
            provider = ai.provider;
            model = ai.model;
            parsed = typeof ai.data === 'object' ? ai.data : JSON.parse(extractJsonObject((ai as any).content));
        } catch {
            break;
        }

        if (parsed?.final) {
            answer = String(parsed.final).trim();
            if (Array.isArray(parsed.followups)) lastRender = { ...(lastRender as any), followups: parsed.followups } as any;
            break;
        }

        const toolName = parsed?.tool as ToolName;
        if (toolName && !VALID_TOOLS.has(toolName)) {
            // AI gọi tool không tồn tại -> nhắc danh sách tool đúng (không ép finalize sớm).
            convo.push({ role: 'assistant', content: JSON.stringify(parsed) });
            convo.push({
                role: 'user',
                content:
                    'Tool do khong ton tai. Chi duoc dung: search_assets, top_broken_assets, low_stock_materials, top_used_materials, search_materials, material_usage_by_plant, purchase_analysis, purchase_orders, cost_variance, summary_metrics. Hay chon tool dung; neu cau hoi ngoai pham vi, tra {"final":"giai thich ngan"}.',
            });
            continue;
        }
        if (!toolName || toolCalls >= MAX_TOOL_CALLS) {
            // hết lượt tool -> ép trả lời từ dữ liệu đã có
            convo.push({ role: 'user', content: 'Da du du lieu (hoac het luot truy van), hay tra ve {"final":...} ngay dua tren cac ket qua tool da co.' });
            continue;
        }

        toolCalls += 1;
        const outcome = await executeTool(toolName, parsed.args);
        if (outcome.render) lastRender = outcome.render;
        convo.push({ role: 'assistant', content: JSON.stringify({ tool: toolName, args: parsed.args }) });
        convo.push({ role: 'user', content: `KET QUA ${toolName}: ${JSON.stringify(outcome.ai).slice(0, 3500)}` });
    }

    // Lưới an toàn: AI không gọi tool nào (trả lời chay / lỗi provider) nhưng câu hỏi rõ ràng cần dữ liệu
    // -> tự định tuyến heuristic, chạy tool thật, và dựng câu trả lời từ số liệu (đáng tin hơn câu chữ AI không grounded).
    if (toolCalls === 0) {
        const guess = classifyIntent(lastUser);
        if (guess) {
            try {
                const outcome = await executeTool(guess.tool, guess.args);
                if (outcome.render) lastRender = outcome.render;
                const built = buildDeterministicAnswer(lastRender);
                if (built) {
                    answer = built;
                    if (provider === 'fallback') provider = 'heuristic';
                }
            } catch {
                /* giữ nguyên answer hiện có */
            }
        }
    }

    if (!answer) {
        answer =
            buildDeterministicAnswer(lastRender) ||
            (lastRender
                ? `Tìm thấy ${lastRender.count} kết quả phù hợp.`
                : 'Mình hỗ trợ hỏi đáp về: máy & bảo trì, vật tư & tồn kho, và chi phí (sửa ngoài, cấp phát, mua vật tư). Bạn thử diễn đạt lại câu hỏi theo các mảng này nhé.');
    }

    const followups = (lastRender as any)?.followups?.filter?.((f: any) => typeof f === 'string') ?? [
        'Máy nào quá hạn bảo trì?',
        'Vì sao chi phí tháng này thay đổi?',
        'Vật tư nào sắp hết?',
    ];

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                domain: lastRender?.domain ?? 'asset',
                answer,
                intent: 'agent',
                count: lastRender?.count ?? 0,
                items: lastRender?.items ?? [],
                aggregates: lastRender?.aggregates ?? {},
                appliedFilters: lastRender?.appliedFilters,
                followups: followups.slice(0, 3),
                provider,
                model,
            },
            message: 'Tro ly da xu ly cau hoi',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
