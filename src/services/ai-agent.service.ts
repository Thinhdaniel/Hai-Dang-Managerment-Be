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
import {
    analyzePurchases,
    distributionAnalysis,
    listPurchaseOrders,
    materialPriceHistory,
    materialUsageByPlant,
    purchaseSuggestion,
    supplierComparison,
} from '@/services/ai-material-insight.service';
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
    | 'material_price_history'
    | 'supplier_comparison'
    | 'distribution_analysis'
    | 'purchase_suggestion'
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
        case 'material_price_history': {
            const h = await materialPriceHistory(args || {});
            return {
                ai: {
                    vatTu: h.materialName,
                    soLanMua: h.count,
                    giaThapNhat: h.minPrice,
                    giaCaoNhat: h.maxPrice,
                    giaTB: h.avgPrice,
                    xuHuongGiaPct: h.trendPct,
                    cacLanGanDay: h.points.slice(-6).map((p: any) => ({ ma: p.orderCode, ncc: p.supplierName, gia: p.unitPrice, sl: p.qty })),
                },
                render: { domain: 'cost', count: h.count, items: [], aggregates: { priceHistory: h } },
            };
        }
        case 'supplier_comparison': {
            const s = await supplierComparison(args || {});
            return {
                ai: {
                    vatTu: s.materialName,
                    reNhat: s.cheapest,
                    nhaCungCap: s.suppliers.slice(0, 8).map((x: any) => ({ ncc: x.supplierName, giaTB: x.avgPrice, soDon: x.orders })),
                },
                render: { domain: 'cost', count: s.suppliers.length, items: [], aggregates: { supplierComparison: s } },
            };
        }
        case 'distribution_analysis': {
            const d = await distributionAnalysis(args || {});
            return {
                ai: {
                    ky: d.periodLabel,
                    coSo: d.plantName || 'tất cả',
                    tongGiaTri: d.totalValue,
                    tongThieuHut: d.totalShortageQty,
                    soDongThieu: d.totalShortageLines,
                    topVatTu: d.topMaterials.slice(0, 6).map((m: any) => ({ ten: m.materialName, sl: m.qty, giaTri: m.value })),
                    topThieuHut: d.topShortages.slice(0, 5).map((m: any) => ({ ten: m.materialName, thieu: m.shortageQty })),
                },
                render: { domain: 'cost', count: d.topMaterials.length, items: [], aggregates: { distributionAnalysis: d } },
            };
        }
        case 'purchase_suggestion': {
            const p = await purchaseSuggestion(args || {});
            return {
                ai: {
                    soVatTuCanMua: p.count,
                    danhSach: p.suggestions.slice(0, 12).map((s: any) => ({ ten: s.materialName, ton: s.stock, dinhMuc: s.minLevel, dung30Ngay: s.used30, nenMua: s.suggestQty, donVi: s.unit })),
                },
                render: { domain: 'material', count: p.count, items: [], aggregates: { purchaseSuggestion: p } },
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
    if (n.includes('nen mua') || n.includes('de xuat mua') || n.includes('len ke hoach mua') || n.includes('ke hoach mua') || n.includes('can mua gi') || n.includes('can bo sung')) {
        return { tool: 'purchase_suggestion', args: {} };
    }
    if (n.includes('mua') && (n.includes('phan tich') || n.includes('chi tiet') || n.includes('vat tu nao') || n.includes('nha cung cap') || n.includes('ncc') || n.includes('so sanh'))) {
        return { tool: 'purchase_analysis', args: { period: detectPeriod(q), groupBy: n.includes('nha cung cap') || n.includes('ncc') ? 'supplier' : 'material' } };
    }
    if (n.includes('cap phat') && (n.includes('thieu hut') || n.includes('thieu hang') || n.includes('shortage') || n.includes('chi tiet') || n.includes('cap bu'))) {
        return { tool: 'distribution_analysis', args: { plantName: q, period: n.includes('thang') || n.includes('tuan') ? detectPeriod(q) : undefined } };
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
    if (a.priceHistory) {
        const h = a.priceHistory;
        if (!h.count) return `Chưa có dữ liệu mua "${h.materialName}".`;
        const trend = h.trendPct > 0 ? `tăng ${h.trendPct}%` : h.trendPct < 0 ? `giảm ${Math.abs(h.trendPct)}%` : 'ổn định';
        return `Giá mua "${h.materialName}" qua ${h.count} lần: thấp nhất ${fmtVnd(h.minPrice)}, cao nhất ${fmtVnd(h.maxPrice)}, TB ${fmtVnd(h.avgPrice)}/${h.unit}; xu hướng ${trend} (lần đầu→gần nhất).`;
    }
    if (a.supplierComparison) {
        const s = a.supplierComparison;
        if (!s.suppliers.length) return `Chưa có dữ liệu nhà cung cấp cho "${s.materialName}".`;
        const cheap = s.suppliers[0];
        return `"${s.materialName}" rẻ nhất ở ${cheap.supplierName} (TB ${fmtVnd(cheap.avgPrice)}/${cheap.unit}, ${cheap.orders} đơn)` + (s.suppliers[1] ? `; tiếp theo ${s.suppliers[1].supplierName} ${fmtVnd(s.suppliers[1].avgPrice)}.` : '.');
    }
    if (a.distributionAnalysis) {
        const d = a.distributionAnalysis;
        const at = d.plantName ? ` ở ${d.plantName}` : '';
        const head = `Cấp phát ${d.periodLabel}${at}: tổng ${fmtVnd(d.totalValue)}.`;
        const sh = d.totalShortageQty > 0 ? ` Thiếu hụt ${d.totalShortageQty} đơn vị ở ${d.totalShortageLines} dòng${d.topShortages[0] ? ` (nhiều nhất: ${d.topShortages[0].materialName} thiếu ${d.topShortages[0].shortageQty})` : ''}.` : ' Không có thiếu hụt.';
        return head + sh;
    }
    if (a.purchaseSuggestion) {
        const p = a.purchaseSuggestion;
        if (!p.count) return 'Hiện không có vật tư nào cần mua thêm (tồn đủ định mức & nhu cầu).';
        const top = p.suggestions.slice(0, 3).map((s: any) => `${s.materialName} (nên mua ${s.suggestQty} ${s.unit}, tồn ${s.stock})`);
        return `Đề xuất mua ${p.count} vật tư. Ưu tiên: ${top.join('; ')}.`;
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
    'Ban la TRO LY VAN HANH cap cao cho cong ty may, ho tro ban giam doc ra quyet dinh.',
    'Nguyen tac: PHAN TICH ky cau hoi -> TU GOI TOOL lay du lieu THAT -> neu can ghep nhieu nguon thi goi nhieu tool -> roi tra loi/lap ke hoach.',
    'Moi buoc chi tra ve DUY NHAT 1 JSON (khong markdown, khong giai thich ngoai JSON):',
    '- Goi tool: {"tool":"ten_tool","args":{...}}',
    '- Tra loi cuoi: {"final":"cau tra loi tieng Viet co dau, ro rang","followups":["cau hoi goi y 1","cau hoi goi y 2"]}',
    '',
    'QUY TAC VANG:',
    '- TUYET DOI khong bia so lieu/ten. Moi con so phai den tu ket qua tool. Neu thieu du lieu, noi ro "chua co du lieu".',
    '- Cau hoi PHUC TAP (lap ke hoach, so sanh, "co nen", ghep nhieu mang): goi LAN LUOT nhieu tool roi TONG HOP. Vd "don can may 1 kim hikari, con may ranh khong?" -> goi search_assets{search:"1 kim", brandName:"hikari", status:["storage"]} roi ket luan co/khong + de xuat dieu chuyen.',
    '- Cau hoi MO HO/thieu thong tin -> tra {"final":"cau hoi lai ngan gon"} de hoi ro (vd thieu ky, thieu ten vat tu).',
    '- Luon TRICH NGUON trong cau tra loi (ten co so, ma don, ten NCC) de giam doc tin.',
    '- Khi du du lieu thi tra {"final":...} ngay, dung goi tool thua.',
    '',
    'TOOL MAY MOC:',
    '- search_assets(args:{search?, status?:[active|maintenance|broken|borrowing|storage|returned_to_partner], ownershipType?:[owned|partner_borrowed|rental], plantName?, brandName?, area?, flags?:[overdue_maintenance|mislocated|no_qr|not_scanned], aggregate?:count|sum_value|breakdown_by_status|breakdown_by_plant, limit?}): tim/dem/liet ke may. May "ranh/khong dung" = status:["storage"]. Ten LOAI may o "search" (vd "1 kim"); ten HANG dung brandName (KHONG nhet vao search).',
    '- top_broken_assets(args:{plantName?,limit?}): may hong nhieu nhat.',
    '',
    'TOOL VAT TU & KHO:',
    '- low_stock_materials(args:{limit?}): vat tu duoi dinh muc ton.',
    '- top_used_materials(args:{limit?}): vat tu cap phat nhieu nhat (tong).',
    '- material_usage_by_plant(args:{plantName?, period?:week|month, limit?}): vat tu cap phat nhieu nhat PHAN RA THEO CO SO nhan.',
    '- distribution_analysis(args:{plantName?, period?:week|month, limit?}): phan tich CAP PHAT chi tiet + THIEU HUT (shortage) theo vat tu/co so. Dung khi hoi ve cap phat, thieu hut, cap bu.',
    '- search_materials(args:{search?,category?,limit?}): tim vat tu.',
    '',
    'TOOL CHI PHI MUA & DON HANG:',
    '- cost_variance(args:{metric:repair_cost|distribution_cost|purchase_cost|total_cost|maintenance_tickets, period:week|month}): TONG chi phi & bien dong vs ky truoc, phan ra theo CO SO. "mua"=purchase_cost, "cap phat"=distribution_cost, "sua ngoai"=repair_cost.',
    '- purchase_analysis(args:{period:week|month, groupBy?:material|supplier, limit?}): chi phi MUA chi tiet ky nay vs ky truoc, phan ra theo VAT TU hoac NHA CUNG CAP.',
    '- purchase_orders(args:{search?, orderCode?, supplierName?, plantName?, status?, period?:week|month, limit?}): tra cuu DON HANG. Truyen orderCode/search de SOI SAU 1 don (tung dong vat tu, SL dat/nhan).',
    '- material_price_history(args:{materialName, limit?}): LICH SU GIA mua 1 vat tu qua tung don + xu huong tang/giam. Dung khi hoi "gia ... thay doi the nao", "mua bao nhieu lan".',
    '- supplier_comparison(args:{materialName, limit?}): SO SANH GIA giua cac NHA CUNG CAP cho 1 vat tu. Dung khi hoi "mua cho nao re", "ncc nao gia tot".',
    '',
    'TOOL LAP KE HOACH & TONG QUAN:',
    '- purchase_suggestion(args:{limit?}): DE XUAT MUA SAM (tu ton duoi dinh muc + tieu hao 30 ngay). Dung khi hoi "nen mua gi", "len ke hoach mua", "can bo sung vat tu nao".',
    '- summary_metrics(): tong quan toan he thong.',
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
    'material_price_history',
    'supplier_comparison',
    'distribution_analysis',
    'purchase_suggestion',
    'cost_variance',
    'summary_metrics',
]);
// Ngan sach suy luan: cau giam doc thuong can ghep nhieu nguon -> cho nhieu luot hon.
const MAX_TOOL_CALLS = 5;
const MAX_ITERATIONS = 10;

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
            const ai = await aiProviderService.generateJson<any>({ feature, temperature: 0.1, maxTokens: 1200, messages: convo });
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
                    'Tool do khong ton tai. Chi duoc dung: search_assets, top_broken_assets, low_stock_materials, top_used_materials, search_materials, material_usage_by_plant, distribution_analysis, purchase_analysis, purchase_orders, material_price_history, supplier_comparison, purchase_suggestion, cost_variance, summary_metrics. Hay chon tool dung; neu cau hoi ngoai pham vi, tra {"final":"giai thich ngan"}.',
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
