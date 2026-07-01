import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import Material from '@/models/Material';
import InventoryStock from '@/models/InventoryStock';
import DistributionRecord from '@/models/DistributionRecord';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { aiProviderService, extractJsonObject } from '@/services/ai/ai-provider.service';
import { ASSET_SEARCH_TIERS } from '@/constant/aiModels';
import { assetQueryTool, buildTransferDraft, type AssistantMessage } from '@/services/ai-asset-assistant.service';
import { computeVarianceData } from '@/services/variance.service';
import {
    analyzePurchases,
    comparePurchaseVsIssue,
    costOverview,
    distributionAnalysis,
    listPurchaseOrders,
    materialPriceHistory,
    materialUsageByPlant,
    purchaseSuggestion,
    supplierComparison,
} from '@/services/ai-material-insight.service';
import { locateAsset, transferOrders } from '@/services/ai-asset-tools.service';
import {
    analyzeMaterialRequests,
    listMaterialRequests,
    requestBacklog,
    requestLifecycle,
    requestRiskAnalysis,
} from '@/services/ai-request-insight.service';
import customResponse from '@/utils/response';

const normalize = (v?: string) =>
    (v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

// Câu cần SUY LUẬN SÂU / TỔNG HỢP / LẬP KẾ HOẠCH -> tầng nặng (model mạnh nhất).
const HEAVY_SIGNALS = [
    'phan tich', 'so sanh', 'tai sao', 'vi sao', 'danh gia', 'du doan', 'xu huong', 'khuyen nghi', 'tu van',
    'de xuat', 'toi uu', 'co nen', 'lap ke hoach', 'ke hoach', 'nen mua', 'du bao', 'tong hop', 'vi sao',
    'chi tiet', 'co du', 'con du', 'dieu chuyen co', // câu ghép xuyên mảng thường phức tạp
];
// Câu tra cứu ĐƠN GIẢN (liệt kê/đếm/tìm/vị trí) -> tầng nhẹ (model nhanh-rẻ).
const LIGHT_SIGNALS = ['liet ke', 'danh sach', 'bao nhieu', 'dem ', 'co may nao', 'may nao dang', 'o dau', 'vi tri', 'tim may', 'sap het'];
const tierFor = (q: string) => {
    const n = normalize(q);
    if (HEAVY_SIGNALS.some((k) => n.includes(k))) return ASSET_SEARCH_TIERS.heavy;
    if (LIGHT_SIGNALS.some((k) => n.includes(k)) || n.length <= 28) return ASSET_SEARCH_TIERS.light;
    return ASSET_SEARCH_TIERS.standard;
};
const tierLabelOf = (feature: string): 'light' | 'standard' | 'heavy' =>
    feature === ASSET_SEARCH_TIERS.heavy ? 'heavy' : feature === ASSET_SEARCH_TIERS.light ? 'light' : 'standard';

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
    | 'locate_asset'
    | 'transfer_orders'
    | 'draft_transfer'
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
    | 'supply_requests'
    | 'supply_request_analysis'
    | 'purchase_requests'
    | 'purchase_request_analysis'
    | 'request_lifecycle'
    | 'request_backlog'
    | 'request_risk_analysis'
    | 'purchase_suggestion'
    | 'cost_variance'
    | 'cost_overview'
    | 'compare_cost'
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
        case 'locate_asset': {
            const r = await locateAsset(args || {});
            return {
                ai: r.asset
                    ? {
                          ma: r.asset.machineCode,
                          ten: r.asset.name,
                          serial: r.asset.serial,
                          tinhTrang: r.asset.statusLabel,
                          coSoQuanLy: r.asset.managedPlant,
                          khuVuc: r.asset.area,
                          viTriQuetCuoi: r.asset.lastSeenPlant,
                          lechViTri: r.asset.mislocated,
                          lenhDieuChuyenDangMo: r.asset.activeTransfers.map((t: any) => `${t.from}→${t.to} (${t.statusLabel})`),
                          soBanGhiKhop: r.found,
                      }
                    : { khongTimThay: args?.query },
                render: { domain: 'asset', count: r.found, items: [], aggregates: { locate: r } },
            };
        }
        case 'transfer_orders': {
            const t = await transferOrders(args || {});
            return {
                ai: {
                    ky: t.periodLabel,
                    tongSoLenh: t.count,
                    cacLenh: t.orders.slice(0, 8).map((o: any) => ({
                        tu: o.from,
                        den: o.to,
                        trangThai: o.statusLabel,
                        ngay: o.transferDate,
                        soMay: o.assetCount,
                        may: o.machines.slice(0, 6).map((m: any) => m.machineCode),
                    })),
                },
                render: { domain: 'asset', count: t.count, items: [], aggregates: { transferOrders: t } },
            };
        }
        case 'draft_transfer': {
            // Soạn NHÁP lệnh điều chuyển (AI soạn → FE mở form → người chốt). KHÔNG tạo lệnh ở đây.
            const d = await buildTransferDraft(args?.machineRefs ?? [], args?.toPlantName ?? undefined);
            return {
                ai: {
                    soMay: d.count,
                    coSoDich: d.transferDraft.toPlantName,
                    chuaKhop: d.transferDraft.unresolved,
                    canhBao: d.transferDraft.warnings,
                    may: d.items.slice(0, 8).map((i: any) => ({ ma: i.machineCode, ten: i.name, coSoHienTai: i.plantName })),
                },
                render: {
                    domain: 'asset',
                    count: d.count,
                    items: d.items,
                    aggregates: { transferDraft: d.transferDraft, transferAnswer: d.answer },
                },
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
                    coSo: p.plantName || 'toàn hệ thống',
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
                        danhSachNcc: d.suppliers, // 1 PO có thể gồm NHIỀU nhà cung cấp (mỗi dòng 1 NCC)
                        soNcc: d.supplierCount,
                        coSo: d.plantName,
                        cacCoSo: d.plants,
                        trangThai: d.statusLabel,
                        tongTien: d.totalWithVat,
                        soDongVatTu: d.itemCount,
                        ...(d.items ? { vatTu: d.items.map((it: any) => ({ ten: it.materialName, sl: `${it.quantityOrdered} ${it.unit}`, gia: it.totalWithVat, ncc: it.supplierName, coSo: it.plantName })) } : {}),
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
        case 'supply_requests': {
            const r = await listMaterialRequests({ ...(args || {}), kind: 'supply' });
            return {
                ai: {
                    loai: r.title,
                    ky: r.periodLabel,
                    tongSoPhieu: r.total,
                    tongGiaTri: r.summary.totalValue,
                    theoTrangThai: r.summary.byStatus,
                    theoCoSo: r.summary.byPlant,
                    topVatTu: r.summary.topMaterials.slice(0, 6),
                    phieu: r.rows.slice(0, 12).map((x: any) => ({
                        ma: x.requestCode,
                        trangThai: x.statusLabel,
                        coSoGui: x.fromPlantName || x.plantName,
                        nguoiDeXuat: x.requestedBy,
                        soDong: x.itemCount,
                        daCapPhat: x.distribution?.distributionCodes,
                        conThieu: x.distribution?.outstandingQty,
                        ngayTao: x.createdAt,
                    })),
                },
                render: { domain: 'material', count: r.total, items: [], aggregates: { materialRequests: r } },
            };
        }
        case 'supply_request_analysis': {
            const r = await analyzeMaterialRequests({ ...(args || {}), kind: 'supply' });
            return {
                ai: {
                    loai: r.title,
                    ky: r.periodLabel,
                    tongSoPhieu: r.total,
                    theoTrangThai: r.byStatus,
                    theoCoSo: r.byPlant,
                    nguoiDeXuatNhieu: r.byRequester.slice(0, 5),
                    topVatTu: r.topMaterials.slice(0, 8),
                    choDuyetLau: r.oldestPending.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.fromPlantName, ngayCho: x.ageDays, nguoi: x.requestedBy })),
                    daDuyetChuaCap: r.approvedWithoutNextStep.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.fromPlantName, ngayCho: x.ageDays })),
                    thieuVatTu: r.shortages.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.fromPlantName, conThieu: x.distribution?.outstandingQty })),
                },
                render: { domain: 'material', count: r.total, items: [], aggregates: { requestAnalysis: r } },
            };
        }
        case 'purchase_requests': {
            const r = await listMaterialRequests({ ...(args || {}), kind: 'purchase_all' });
            return {
                ai: {
                    loai: r.title,
                    ky: r.periodLabel,
                    tongSoPhieu: r.total,
                    tongGiaTri: r.summary.totalValue,
                    theoTrangThai: r.summary.byStatus,
                    theoCoSo: r.summary.byPlant,
                    topVatTu: r.summary.topMaterials.slice(0, 6),
                    phieu: r.rows.slice(0, 12).map((x: any) => ({
                        ma: x.requestCode,
                        loaiPhieu: x.requestTypeLabel,
                        trangThai: x.statusLabel,
                        coSo: x.plantName,
                        nguoiDeXuat: x.requestedBy,
                        tongTien: x.totalWithVat,
                        donMua: x.orders?.orderCodes,
                        daDat: x.orders?.orderedQty,
                        daNhan: x.orders?.receivedQty,
                        conThieu: x.orders?.missingQty,
                        ngayTao: x.createdAt,
                    })),
                },
                render: { domain: 'material', count: r.total, items: [], aggregates: { materialRequests: r } },
            };
        }
        case 'purchase_request_analysis': {
            const r = await analyzeMaterialRequests({ ...(args || {}), kind: 'purchase_all' });
            return {
                ai: {
                    loai: r.title,
                    ky: r.periodLabel,
                    tongSoPhieu: r.total,
                    tongGiaTri: r.totalValue,
                    theoTrangThai: r.byStatus,
                    theoCoSo: r.byPlant,
                    nguoiDeXuatNhieu: r.byRequester.slice(0, 5),
                    topVatTu: r.topMaterials.slice(0, 8),
                    choDuyetLau: r.oldestPending.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.plantName, ngayCho: x.ageDays, nguoi: x.requestedBy })),
                    daDuyetChuaLenDon: r.approvedWithoutNextStep.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.plantName, ngayCho: x.ageDays })),
                    chuaNhanDu: r.shortages.slice(0, 5).map((x: any) => ({ ma: x.requestCode, don: x.orders?.orderCodes, conThieu: x.orders?.missingQty })),
                },
                render: { domain: 'material', count: r.total, items: [], aggregates: { requestAnalysis: r } },
            };
        }
        case 'request_lifecycle': {
            const r = await requestLifecycle(args || {});
            return {
                ai: r.request
                    ? {
                          ma: r.request.requestCode,
                          loai: r.request.requestTypeLabel,
                          trangThai: r.request.statusLabel,
                          coSo: r.request.fromPlantName || r.request.plantName,
                          nguoiDeXuat: r.request.requestedBy,
                          dongThoiGian: r.timeline,
                          vatTu: r.request.items?.slice(0, 8).map((it: any) => ({ ten: it.materialName, slDeXuat: it.quantityRequested, slDuyet: it.quantityApproved, slDat: it.quantityOrdered })),
                          donMua: r.request.orders?.orderCodes,
                          phieuCapPhat: r.request.distribution?.distributionCodes,
                          conThieu: r.request.distribution?.outstandingQty || r.request.orders?.missingQty,
                      }
                    : { khongTimThay: args?.requestCode || args?.search, ghiChu: r.message },
                render: { domain: 'material', count: r.found, items: [], aggregates: { requestLifecycle: r } },
            };
        }
        case 'request_backlog': {
            const r = await requestBacklog(args || {});
            return {
                ai: {
                    ky: r.periodLabel,
                    theTongHop: r.cards,
                    deXuatCap: {
                        tong: r.supply.total,
                        choXuLy: r.supply.oldestPending.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.fromPlantName, ngayCho: x.ageDays })),
                        conThieu: r.supply.shortages.slice(0, 5).map((x: any) => ({ ma: x.requestCode, conThieu: x.distribution?.outstandingQty })),
                    },
                    deXuatMua: {
                        tong: r.purchase.total,
                        choXuLy: r.purchase.oldestPending.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.plantName, ngayCho: x.ageDays })),
                        chuaLenDon: r.purchase.approvedWithoutNextStep.slice(0, 5).map((x: any) => ({ ma: x.requestCode, coSo: x.plantName })),
                        chuaNhanDu: r.purchase.shortages.slice(0, 5).map((x: any) => ({ ma: x.requestCode, conThieu: x.orders?.missingQty })),
                    },
                },
                render: { domain: 'material', count: r.cards.reduce((s: number, c: any) => s + Number(c.count || 0), 0), items: [], aggregates: { requestBacklog: r } },
            };
        }
        case 'request_risk_analysis': {
            const r = await requestRiskAnalysis(args || {});
            return {
                ai: {
                    ky: r.periodLabel,
                    soRuiRo: r.riskCount,
                    ruiRo: r.risks,
                    theTongHop: r.backlogCards,
                },
                render: { domain: 'material', count: r.riskCount, items: [], aggregates: { requestRiskAnalysis: r } },
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
        case 'cost_overview': {
            const c = await costOverview(args || {});
            return {
                ai: {
                    ky: c.periodLabel,
                    kyTruoc: c.prevLabel,
                    muaVatTu: { kyNay: c.purchase.current, kyTruoc: c.purchase.previous, deltaPct: c.purchase.deltaPct },
                    capPhat: { kyNay: c.distribution.current, kyTruoc: c.distribution.previous, deltaPct: c.distribution.deltaPct },
                    suaNgoai: { kyNay: c.repair.current, kyTruoc: c.repair.previous, deltaPct: c.repair.deltaPct },
                    tongCong: { kyNay: c.total.current, kyTruoc: c.total.previous, deltaPct: c.total.deltaPct },
                    ghiChu: 'Mua = nhập kho; Cấp phát = xuất dùng; Sửa ngoài = chi phí sửa chữa. 3 dòng tiền khác bản chất, không cộng gộp để so sánh hiệu quả.',
                },
                render: { domain: 'cost', count: 0, items: [], aggregates: { costOverview: c } },
            };
        }
        case 'compare_cost': {
            const c = await comparePurchaseVsIssue(args || {});
            return {
                ai: {
                    ky: c.periodLabel,
                    muaVatTu: c.purchase.current,
                    capPhat: c.distribution.current,
                    chenhLech: c.gap,
                    caoHon: c.higher === 'purchase' ? 'mua nhiều hơn cấp phát (tăng tồn kho)' : c.higher === 'distribution' ? 'cấp phát nhiều hơn mua (giảm tồn kho)' : 'bằng nhau',
                },
                render: { domain: 'cost', count: 0, items: [], aggregates: { compareCost: c } },
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

const extractRequestCode = (q: string): string | undefined => {
    const m = q.match(/\b(?:YC|DX|KT)[-_]?\d{6,}[-_\dA-Za-z]*\b/i);
    return m ? m[0] : undefined;
};

// Trích các MÃ MÁY/serial nhiều đoạn (vd "MCV-SANTIAN-HD-001", "VS4C-SIRUBA-HD-002") — giữ mã có cả chữ lẫn số.
const extractMachineCodes = (q: string): string[] => {
    const raw = q.match(/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+\b/g) || [];
    return [...new Set(raw.filter((c) => /[A-Za-z]/.test(c) && /\d/.test(c) && c.length >= 5))];
};

// Lấy tên cơ sở ĐÍCH đứng sau "sang/tới/đến/về/qua ...".
const extractTransferDest = (q: string): string | undefined => {
    const m = q.match(/\b(?:sang|tới|toi|đến|den|về|ve|qua)\s+(.+)$/i);
    if (!m) return undefined;
    const dest = m[1].trim().split(/[,.;\n]/)[0].trim();
    return dest || undefined;
};

// Nhận diện ý định SOẠN lệnh điều chuyển (khác với XEM danh sách lệnh đã có):
// cần có mã máy cụ thể + động từ soạn hoặc cơ sở đích.
const transferDraftRoute = (q: string): { tool: ToolName; args: any } | null => {
    const n = normalize(q);
    const refs = extractMachineCodes(q);
    if (!refs.length) return null;
    const hasDest = / sang | toi | den | ve | qua /.test(` ${n} `);
    const draftVerb =
        n.includes('soan lenh') ||
        n.includes('tao lenh') ||
        n.includes('lap lenh') ||
        n.includes('lam lenh') ||
        n.includes('tao phieu dieu chuyen') ||
        /(dieu chuyen|chuyen)\s+(may|thiet bi|no|nay|con)/.test(n);
    if (!hasDest && !draftVerb) return null;
    return { tool: 'draft_transfer', args: { machineRefs: refs, toPlantName: extractTransferDest(q) } };
};

const hasSupplyRequestSignal = (n: string) =>
    n.includes('phieu de xuat cap') ||
    n.includes('de xuat cap vat tu') ||
    n.includes('yeu cau cap') ||
    n.includes('yc-') ||
    n.includes('yc_');

const hasPurchaseRequestSignal = (n: string) =>
    n.includes('phieu de xuat mua') ||
    n.includes('de xuat mua vat tu') ||
    n.includes('giay de nghi mua') ||
    n.includes('dx-') ||
    n.includes('dx_') ||
    n.includes('kt-') ||
    n.includes('kt_');

const requestRoute = (q: string): { tool: ToolName; args: any } | null => {
    const n = normalize(q);
    const code = extractRequestCode(q);
    const period = n.includes('tuan') ? 'week' : n.includes('thang') ? 'month' : undefined;
    const status =
        n.includes('ban nhap') || n.includes('nhap')
            ? 'draft'
            : n.includes('cho duyet') || n.includes('cho xu ly') || n.includes('chua xu ly')
              ? 'pending'
              : n.includes('da duyet')
                ? 'approved'
                : n.includes('tu choi')
                  ? 'rejected'
                  : n.includes('da cap') || n.includes('hoan thanh')
                    ? 'distributed'
                    : undefined;

    if (code || n.includes('vong doi') || n.includes('chi tiet phieu') || n.includes('cu the tu tao')) {
        if (code || hasSupplyRequestSignal(n) || hasPurchaseRequestSignal(n)) {
            return { tool: 'request_lifecycle', args: { requestCode: code, search: code || q } };
        }
    }

    const hasSupply = hasSupplyRequestSignal(n);
    const hasPurchase = hasPurchaseRequestSignal(n);
    const asksBoth =
        (hasSupply && hasPurchase) ||
        (n.includes('de xuat cap') && n.includes('de xuat mua')) ||
        (n.includes('thieu') && n.includes('mua tuong ung')) ||
        n.includes('lien ket phieu') ||
        n.includes('quy trinh hien tai') ||
        n.includes('rui ro van hanh') ||
        n.includes('hanh dong uu tien') ||
        n.includes('hop van hanh') ||
        n.includes('backlog') ||
        n.includes('diem nghen');

    if (asksBoth) {
        if (n.includes('rui ro') || n.includes('hanh dong') || n.includes('hop') || n.includes('bat thuong') || n.includes('uu tien')) {
            return { tool: 'request_risk_analysis', args: { period: period || 'month' } };
        }
        return { tool: 'request_backlog', args: { period: period || 'all' } };
    }

    if (hasSupply) {
        const search = n.includes('lien quan') || n.includes('tim') ? q : undefined;
        if (
            n.includes('phan tich') ||
            n.includes('danh gia') ||
            n.includes('top') ||
            n.includes('bao nhieu') ||
            n.includes('tong') ||
            n.includes('co so nao') ||
            n.includes('nguoi de xuat') ||
            n.includes('vat tu nao') ||
            n.includes('cho duyet lau') ||
            n.includes('thieu') ||
            n.includes('bat thuong') ||
            n.includes('tang') ||
            n.includes('giam')
        ) {
            return { tool: 'supply_request_analysis', args: { period: period || 'month', status, search } };
        }
        return { tool: 'supply_requests', args: { period: period || 'month', status, search, limit: 12 } };
    }

    if (hasPurchase) {
        const search = n.includes('lien quan') || n.includes('tim') ? q : undefined;
        if (
            n.includes('phan tich') ||
            n.includes('danh gia') ||
            n.includes('top') ||
            n.includes('bao nhieu') ||
            n.includes('tong') ||
            n.includes('co so nao') ||
            n.includes('nguoi de xuat') ||
            n.includes('vat tu nao') ||
            n.includes('chua len don') ||
            n.includes('chua dat hang') ||
            n.includes('chua nhan') ||
            n.includes('trung vat tu') ||
            n.includes('tang') ||
            n.includes('giam') ||
            n.includes('gia tri lon')
        ) {
            return { tool: 'purchase_request_analysis', args: { period: period || 'month', status, search } };
        }
        return { tool: 'purchase_requests', args: { period: period || 'month', status, search, limit: 12 } };
    }

    return null;
};

// Đoán tool đúng từ từ khóa (chỉ cho các mảng dữ liệu rõ ràng — KHÔNG đoán bừa câu hội thoại).
const classifyIntent = (q: string): { tool: ToolName; args: any } | null => {
    const n = normalize(q);
    const code = extractOrderCode(q);
    const routedRequest = requestRoute(q);
    if (routedRequest) return routedRequest;
    // Soạn nháp lệnh điều chuyển (có mã máy + đích) — ưu tiên trước nhánh XEM danh sách lệnh.
    const draftRoute = transferDraftRoute(q);
    if (draftRoute) return draftRoute;
    // Lệnh điều chuyển (ưu tiên trước đơn mua).
    if (n.includes('dieu chuyen') || n.includes('lenh chuyen')) {
        const period = n.includes('hom nay') ? 'today' : n.includes('tuan') ? 'week' : n.includes('thang') ? 'month' : undefined;
        const status = n.includes('cho duyet') ? 'pending' : n.includes('hoan tat') ? 'completed' : undefined;
        return { tool: 'transfer_orders', args: { period, status } };
    }
    // Tra cứu 1 máy theo mã/serial khi hỏi vị trí.
    if (code && (n.includes('o dau') || n.includes('vi tri') || n.includes('dang o') || n.includes('tim may') || n.includes('may nay'))) {
        return { tool: 'locate_asset', args: { query: code } };
    }
    if ((code && (n.includes('don hang') || n.includes('don mua') || n.includes('don dat'))) || n.includes('don hang') || n.includes('don mua') || n.includes('don dat')) {
        return { tool: 'purchase_orders', args: { search: code, period: n.includes('thang') || n.includes('tuan') ? detectPeriod(q) : undefined } };
    }
    if (n.includes('nen mua') || n.includes('len ke hoach mua') || n.includes('ke hoach mua') || n.includes('can mua gi') || n.includes('can bo sung')) {
        return { tool: 'purchase_suggestion', args: {} };
    }
    // So sánh MUA vs CẤP PHÁT.
    if (n.includes('so sanh') && n.includes('mua') && n.includes('cap phat')) {
        return { tool: 'compare_cost', args: { period: detectPeriod(q) } };
    }
    const hasPlant = /co so|\bc\.?\s*s\.?\s*\d/.test(n);
    if (n.includes('mua') && (n.includes('phan tich') || n.includes('chi tiet') || n.includes('vat tu nao') || n.includes('nha cung cap') || n.includes('ncc') || n.includes('so sanh'))) {
        return {
            tool: 'purchase_analysis',
            args: { period: detectPeriod(q), groupBy: n.includes('nha cung cap') || n.includes('ncc') ? 'supplier' : 'material', plantName: hasPlant ? q : undefined },
        };
    }
    if (
        n.includes('cap phat') &&
        (n.includes('thieu hut') || n.includes('thieu hang') || n.includes('shortage') || n.includes('chi tiet') || n.includes('cap bu') || n.includes('chi phi') || n.includes('bao nhieu') || n.includes('tong'))
    ) {
        // "chi phí cấp phát của CS X" -> phân tích cấp phát LỌC theo cơ sở (giá trị tuyệt đối), KHÔNG dùng cost_variance (tổng hệ thống).
        return { tool: 'distribution_analysis', args: { plantName: q, period: n.includes('thang') || n.includes('tuan') ? detectPeriod(q) : undefined } };
    }
    if (n.includes('cap phat') || n.includes('su dung nhieu') || n.includes('dung nhieu') || n.includes('cap nhieu') || n.includes('tieu thu') || (n.includes('vat tu') && n.includes('co so'))) {
        return { tool: 'material_usage_by_plant', args: { plantName: q, period: n.includes('thang') || n.includes('tuan') ? detectPeriod(q) : undefined } };
    }
    if (n.includes('sap het') || n.includes('duoi dinh muc') || n.includes('ton kho thap') || n.includes('het hang') || n.includes('thieu hang') || n.includes('can mua them')) {
        return { tool: 'low_stock_materials', args: {} };
    }
    if (n.includes('chi phi') || n.includes('bien dong') || n.includes('chi tieu') || n.includes('ton bao nhieu tien') || n.includes('tieu ton')) {
        // Chi phí CHUNG CHUNG (không nói rõ mua/cấp phát/sửa) -> tách 3 loại để không gây hiểu nhầm.
        const hasType = n.includes('mua') || n.includes('cap phat') || n.includes('sua ngoai') || n.includes('sua chua') || n.includes('bao tri');
        if (!hasType) return { tool: 'cost_overview', args: { period: detectPeriod(q) } };
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

// Pre-route BẮT BUỘC: với vài câu rõ ý mà model hay "hỏi lại", ta chạy tool TRƯỚC rồi nạp dữ liệu
// vào hội thoại để model buộc phải trả lời từ số liệu (không hỏi lại, không tự chọn lệch).
const forceRoute = (q: string): { tool: ToolName; args: any } | null => {
    const n = normalize(q);
    const routedRequest = requestRoute(q);
    if (routedRequest) return routedRequest;
    // Soạn nháp lệnh điều chuyển: chạy sẵn để trả thẻ "Mở form điều chuyển" ngay, không để model hỏi lại.
    const draftRoute = transferDraftRoute(q);
    if (draftRoute) return draftRoute;
    // So sánh mua vs cấp phát.
    if (n.includes('so sanh') && n.includes('mua') && n.includes('cap phat')) {
        return { tool: 'compare_cost', args: { period: detectPeriod(q) } };
    }
    // Chi phí CHUNG CHUNG (không nói rõ loại, không 1 cơ sở cụ thể) -> tách 3 loại.
    const isCost = n.includes('chi phi') || n.includes('tong chi') || n.includes('ton bao nhieu tien') || n.includes('tieu ton') || n.includes('chi tieu');
    const hasType = n.includes('mua') || n.includes('cap phat') || n.includes('sua ngoai') || n.includes('sua chua') || n.includes('bao tri');
    const hasPlant = /co so|\bc\.?\s*s\.?\s*\d/.test(n);
    if (isCost && !hasType && !hasPlant) {
        return { tool: 'cost_overview', args: { period: detectPeriod(q) } };
    }
    return null;
};

// Dựng câu trả lời TỪ SỐ LIỆU THẬT trong render (không để AI bịa). Trả null nếu không có gì để nói.
const buildDeterministicAnswer = (render: ToolOutcome['render']): string | null => {
    if (!render) return null;
    const a = render.aggregates || {};
    if (a.transferDraft) return a.transferAnswer || `Đã soạn nháp lệnh điều chuyển cho ${render.count} máy.`;
    if (a.materialRequests) {
        const r = a.materialRequests;
        const rows = r.rows || [];
        const top = rows.slice(0, 5);
        if (!rows.length) return `Không tìm thấy ${String(r.title || 'phiếu đề xuất').toLowerCase()} ${r.periodLabel || ''}.`;
        const value = r.kind === 'purchase' ? `, tổng ${fmtVnd(r.summary?.totalValue || 0)}` : '';
        return (
            `${r.title} ${r.periodLabel}: có ${r.total} phiếu${value}. ` +
            `Gần nhất: ${top
                .map((x: any) => {
                    const plant = x.fromPlantName || x.plantName || 'chưa rõ cơ sở';
                    const tail = r.kind === 'purchase' && x.orders?.orderCodes?.length ? ` → PO ${x.orders.orderCodes.join(', ')}` : '';
                    const shortage = r.kind === 'supply' && x.distribution?.outstandingQty ? `, còn thiếu ${x.distribution.outstandingQty}` : '';
                    return `${x.requestCode} (${plant}, ${x.statusLabel}${shortage})${tail}`;
                })
                .join('; ')}.`
        );
    }
    if (a.requestAnalysis) {
        const r = a.requestAnalysis;
        const status = (r.byStatus || []).slice(0, 4).map((x: any) => `${x.label}: ${x.count}`).join(', ');
        const topMaterial = (r.topMaterials || [])[0];
        const pending = (r.oldestPending || [])[0];
        const noNext = (r.approvedWithoutNextStep || [])[0];
        const shortage = (r.shortages || [])[0];
        let s = `${r.title} ${r.periodLabel}: có ${r.total} phiếu${r.kind === 'purchase' ? `, tổng ${fmtVnd(r.totalValue || 0)}` : ''}.`;
        if (status) s += ` Theo trạng thái: ${status}.`;
        if (topMaterial) s += ` Vật tư xuất hiện nhiều nhất: ${topMaterial.materialName} (${topMaterial.requestCount} dòng, SL đề xuất ${topMaterial.quantityRequested} ${topMaterial.unit || ''}).`;
        if (pending) s += ` Chờ xử lý lâu nhất: ${pending.requestCode} (${pending.ageDays} ngày, ${pending.fromPlantName || pending.plantName || 'chưa rõ cơ sở'}).`;
        if (noNext) s += ` Cần xử lý tiếp: ${noNext.requestCode} đã duyệt nhưng chưa ${r.kind === 'supply' ? 'cấp phát' : 'lên đơn mua'}.`;
        if (shortage) s += ` Có thiếu/chưa nhận đủ nổi bật: ${shortage.requestCode}.`;
        return s;
    }
    if (a.requestLifecycle) {
        const r = a.requestLifecycle;
        const x = r.request;
        if (!x) return r.message || 'Không tìm thấy phiếu đề xuất phù hợp.';
        const timeline = (r.timeline || []).map((t: any) => `${t.label}${t.at ? ` (${new Date(t.at).toLocaleDateString('vi-VN')})` : ''}`).join(' → ');
        const next =
            x.requestType === 'supply_request'
                ? x.distribution?.distributionCodes?.length
                    ? `Phiếu cấp phát: ${x.distribution.distributionCodes.join(', ')}${x.distribution.outstandingQty ? `, còn thiếu ${x.distribution.outstandingQty}` : ''}.`
                    : 'Chưa có phiếu cấp phát.'
                : x.orders?.orderCodes?.length
                  ? `Đơn mua liên quan: ${x.orders.orderCodes.join(', ')}; đã đặt ${x.orders.orderedQty}, đã nhận ${x.orders.receivedQty}, còn thiếu ${x.orders.missingQty}.`
                  : 'Chưa lên đơn mua.';
        return `${x.requestCode} (${x.requestTypeLabel}, ${x.statusLabel}) do ${x.requestedBy || 'chưa rõ người tạo'} tạo cho ${x.fromPlantName || x.plantName || 'chưa rõ cơ sở'}. Vòng đời: ${timeline}. ${next}`;
    }
    if (a.requestBacklog) {
        const b = a.requestBacklog;
        const cards = (b.cards || []).map((c: any) => `${c.label}: ${c.count}${c.quantity ? ` (${c.quantity} đơn vị)` : ''}`).join('; ');
        const supply = b.supply?.oldestPending?.[0];
        const purchase = b.purchase?.approvedWithoutNextStep?.[0];
        let s = `Điểm nghẽn phiếu đề xuất ${b.periodLabel}: ${cards}.`;
        if (supply) s += ` YC cần xử lý trước: ${supply.requestCode} (${supply.ageDays} ngày, ${supply.fromPlantName || supply.plantName || 'chưa rõ cơ sở'}).`;
        if (purchase) s += ` DX cần xử lý trước: ${purchase.requestCode} đã duyệt/chờ nhưng chưa lên đơn.`;
        return s;
    }
    if (a.requestRiskAnalysis) {
        const r = a.requestRiskAnalysis;
        if (!r.risks?.length) return `Chưa thấy rủi ro lớn từ phiếu đề xuất ${r.periodLabel}.`;
        return (
            `Có ${r.riskCount} rủi ro từ phiếu đề xuất ${r.periodLabel}. Ưu tiên: ` +
            r.risks
                .slice(0, 5)
                .map((x: any, i: number) => `${i + 1}. [${x.severity}] ${x.title} — ${x.action}`)
                .join('; ')
        );
    }
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
        const at = p.plantName ? ` ở ${p.plantName}` : '';
        const head = `Chi phí mua vật tư${at} ${p.periodLabel}: ${fmtVnd(p.current)} (${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct}% so ${p.prevLabel} ${fmtVnd(p.previous)}).`;
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
    if (a.costOverview) {
        const c = a.costOverview;
        const d = (b: any) => `${b.deltaPct >= 0 ? '+' : ''}${b.deltaPct}%`;
        return (
            `Chi phí ${c.periodLabel} tách theo 3 loại: ` +
            `Mua vật tư ${fmtVnd(c.purchase.current)} (${d(c.purchase)}); ` +
            `Cấp phát ${fmtVnd(c.distribution.current)} (${d(c.distribution)}); ` +
            `Sửa ngoài ${fmtVnd(c.repair.current)} (${d(c.repair)}). ` +
            `Tổng cộng ${fmtVnd(c.total.current)} (${d(c.total)} so ${c.prevLabel}). ` +
            `Lưu ý: mua = nhập kho, cấp phát = xuất dùng — 2 dòng tiền khác bản chất.`
        );
    }
    if (a.compareCost) {
        const c = a.compareCost;
        const which = c.higher === 'purchase' ? 'MUA nhiều hơn cấp phát (đang tăng tồn kho)' : c.higher === 'distribution' ? 'CẤP PHÁT nhiều hơn mua (đang giảm tồn kho)' : 'mua bằng cấp phát';
        return `So sánh ${c.periodLabel}: mua vật tư ${fmtVnd(c.purchase.current)} vs cấp phát ${fmtVnd(c.distribution.current)} → ${which}, chênh ${fmtVnd(Math.abs(c.gap))}.`;
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
    if (a.locate) {
        const x = a.locate.asset;
        if (!x) return 'Không tìm thấy máy nào khớp mã/serial/tên đó.';
        let s = `${x.machineCode} (${x.name})${x.serial ? ` · SN ${x.serial}` : ''} — ${x.statusLabel}, thuộc ${x.managedPlant}${x.area ? `, khu ${x.area}` : ''}.`;
        if (x.lastSeenPlant) s += ` Quét QR lần cuối ở ${x.lastSeenPlant}${x.mislocated ? ' (⚠ lệch vị trí)' : ''}.`;
        s += x.activeTransfers.length
            ? ` Đang có ${x.activeTransfers.length} lệnh điều chuyển: ${x.activeTransfers.map((t: any) => `${t.from}→${t.to} (${t.statusLabel})`).join(', ')}.`
            : ' Không có lệnh điều chuyển đang mở.';
        return s;
    }
    if (a.transferOrders) {
        const t = a.transferOrders;
        if (!t.count) return `Không có lệnh điều chuyển nào ${t.periodLabel}.`;
        const top = t.orders[0];
        let s = `Có ${t.count} lệnh điều chuyển ${t.periodLabel}.`;
        if (top)
            s += ` Gần nhất: ${top.from}→${top.to} (${top.statusLabel}), ${top.assetCount} máy${top.machines[0] ? ` gồm ${top.machines.slice(0, 5).map((m: any) => m.machineCode).join(', ')}` : ''}.`;
        return s;
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
    '- Cau hoi DIEU HANH/TONG HOP rong (vd "bao cao tong hop may + bao tri + dieu chuyen + vat tu + chi phi", "tinh hinh chung thang nay"): TUYET DOI khong tra ve 1 mang duy nhat. Phai goi NHIEU tool (vd summary_metrics + cost_overview + top_broken_assets + transfer_orders + low_stock_materials) roi tong hop thanh bao cao co muc. Neu cau hoi liet ke nhieu khia canh, moi khia canh can it nhat 1 tool.',
    '- Cau hoi SO SANH 2 thu (vd "mua vs cap phat", "thang nay vs thang truoc") -> phai tra ca 2 ve + chenh lech, KHONG chi tra 1 ve.',
    '- Cau hoi MO HO/thieu thong tin -> tra {"final":"cau hoi lai ngan gon"} de hoi ro (vd thieu ky, thieu ten vat tu).',
    '- Luon TRICH NGUON trong cau tra loi (ten co so, ma don, ten NCC) de giam doc tin.',
    '- Khi du du lieu thi tra {"final":...} ngay, dung goi tool thua.',
    '',
    'TOOL MAY MOC:',
    '- search_assets(args:{search?, status?:[active|maintenance|broken|borrowing|storage|returned_to_partner], ownershipType?:[owned|partner_borrowed|rental], plantName?, brandName?, area?, flags?:[overdue_maintenance|mislocated|no_qr|not_scanned], aggregate?:count|sum_value|breakdown_by_status|breakdown_by_plant, limit?}): tim/dem/liet ke NHIEU may theo bo loc. May "ranh/khong dung" = status:["storage"]. Ten LOAI may o "search" (vd "1 kim"); ten HANG dung brandName (KHONG nhet vao search).',
    '- locate_asset(args:{query}): tra cuu 1 MAY CU THE theo MA may / SERIAL / TEN -> vi tri (co so quan ly + khu vuc + noi quet QR cuoi + co lech vi tri khong) + tinh trang + LENH DIEU CHUYEN lien quan. Dung khi hoi "may X dang o dau", "may serial ... co lenh dieu chuyen nao khong".',
    '- transfer_orders(args:{period?:today|week|month, status?:pending|approved|completed|rejected|cancelled, plantName?, limit?}): tra cuu LENH DIEU CHUYEN (kem danh sach may trong lenh). Dung khi hoi "lenh dieu chuyen hom nay/gan day", "lenh gan nhat gom may nao", "lenh nao dang cho duyet". Khong truyen period = gan day (2 tuan).',
    '- draft_transfer(args:{machineRefs:[ma/serial may], toPlantName?}): SOAN NHAP lenh dieu chuyen (KHONG tao that) -> tra the "Mo form dieu chuyen" de nguoi dung chot. Dung khi nguoi dung MUON DIEU CHUYEN may cu the sang co so khac, vd "dieu chuyen may MCV-... sang Co So 2", "soan lenh chuyen 3 may nay ve Co So 1". machineRefs = cac MA MAY/serial trong cau; toPlantName = co so DICH.',
    '- top_broken_assets(args:{plantName?,limit?}): may hong nhieu nhat.',
    '',
    'TOOL VAT TU & KHO:',
    '- low_stock_materials(args:{limit?}): vat tu duoi dinh muc ton.',
    '- top_used_materials(args:{limit?}): vat tu cap phat nhieu nhat (tong).',
    '- material_usage_by_plant(args:{plantName?, period?:week|month, limit?}): vat tu cap phat nhieu nhat PHAN RA THEO CO SO nhan.',
    '- distribution_analysis(args:{plantName?, period?:week|month, limit?}): CHI PHI CAP PHAT (tong gia tri) + top vat tu + THIEU HUT, CO THE LOC 1 CO SO qua plantName. ƯU TIEN dung tool nay khi hoi "chi phi cap phat cua co so X", "CS2 cap phat bao nhieu", "cap phat o <co so>". Truyen plantName = ten co so trong cau hoi.',
    '- search_materials(args:{search?,category?,limit?}): tim vat tu.',
    '',
    'TOOL PHIEU DE XUAT / WORKFLOW VAT TU:',
    '- supply_requests(args:{search?, requestCode?, status?:draft|pending|approved|rejected|distributed|partially_distributed, plantName?, materialName?, period?:week|month|all, limit?}): DANH SACH PHIEU DE XUAT CAP VAT TU (ma YC-...). Dung khi hoi "phieu de xuat cap", "yeu cau cap", danh sach, tim theo vat tu/co so/trang thai.',
    '- supply_request_analysis(args:{status?, plantName?, materialName?, period?:week|month|all, staleDays?}): PHAN TICH PHIEU DE XUAT CAP: dem phieu, theo trang thai/co so/nguoi de xuat, top vat tu, phieu cho duyet lau, da duyet chua cap, con thieu vat tu.',
    '- purchase_requests(args:{search?, requestCode?, status?:draft|pending|approved|rejected|ordered|received, plantName?, materialName?, period?:week|month|all, limit?}): DANH SACH PHIEU DE XUAT MUA VAT TU / GIAY DE NGHI MUA (ma DX-/KT-...). KHAC voi purchase_orders.',
    '- purchase_request_analysis(args:{status?, plantName?, materialName?, period?:week|month|all, staleDays?}): PHAN TICH PHIEU DE XUAT MUA: dem phieu, theo trang thai/co so/nguoi de xuat, top vat tu, chua len don, chua nhan du, gia tri lon.',
    '- request_lifecycle(args:{requestCode|search}): VONG DOI 1 PHIEU YC-/DX-/KT- tu tao -> duyet/tu choi -> cap phat hoac len PO -> nhan/bu thieu.',
    '- request_backlog(args:{period?:week|month|all}): TONG HOP CAC DIEM NGHEN cua de xuat cap + de xuat mua: chua xu ly, da duyet chua cap/len don, con thieu/chua nhan du.',
    '- request_risk_analysis(args:{period?:week|month|all}): CANH BAO/RUI RO/HANH DONG UU TIEN tu phieu de xuat cap + de xuat mua.',
    '  ⚠ BAT BUOC: Neu cau hoi co "PHIEU DE XUAT CAP" hoac ma YC- -> dung supply_requests/supply_request_analysis/request_lifecycle, KHONG dung distribution_analysis lam cau tra loi chinh.',
    '  ⚠ BAT BUOC: Neu cau hoi co "PHIEU DE XUAT MUA" hoac ma DX-/KT- -> dung purchase_requests/purchase_request_analysis/request_lifecycle, KHONG dung purchase_suggestion va KHONG dung purchase_orders tru khi hoi DON HANG/PO.',
    '',
    'TOOL CHI PHI MUA & DON HANG:',
    '- cost_variance(args:{metric:repair_cost|distribution_cost|purchase_cost|total_cost|maintenance_tickets, period:week|month}): current la TONG TOAN HE THONG (TAT CA co so) + bien dong vs ky truoc, kem top co so bien dong. KHONG LOC duoc 1 co so. ⚠ TUYET DOI KHONG dung cho cau hoi ve 1 co so cu the (vd "CS2 bao nhieu") — luc do dung distribution_analysis (cap phat) / purchase_analysis (mua) voi plantName. "mua"=purchase_cost, "cap phat"=distribution_cost, "sua ngoai"=repair_cost.',
    '- purchase_analysis(args:{period:week|month, groupBy?:material|supplier, limit?}): chi phi MUA chi tiet ky nay vs ky truoc, phan ra theo VAT TU hoac NHA CUNG CAP.',
    '- purchase_analysis CHO 1 CO SO: truyen them plantName de loc chi phi mua cua RIENG co so do (loc o cap DONG vat tu). KHONG dung cost_variance(purchase_cost) cho 1 co so.',
    '- purchase_orders(args:{search?, orderCode?, supplierName?, plantName?, status?, period?:week|month, limit?}): tra cuu DON HANG. Truyen orderCode/search de SOI SAU 1 don (tung dong vat tu, SL dat/nhan).',
    '  ⚠ QUAN TRONG: MOI PO gom NHIEU dong vat tu, MOI dong co NHA CUNG CAP & CO SO RIENG (co the trung hoac khac nhau). 1 PO KHONG phai chi 1 NCC. Ket qua tra "danhSachNcc"/"soNcc" cho moi don; khi soNcc>1 phai noi "don X gom N nha cung cap: ..." chu KHONG gan ca don cho 1 NCC. Khi soi chi tiet, neu can thi nhom cac dong theo NCC.',
    '- material_price_history(args:{materialName, limit?}): LICH SU GIA mua 1 vat tu qua tung don + xu huong tang/giam. Dung khi hoi "gia ... thay doi the nao", "mua bao nhieu lan".',
    '- supplier_comparison(args:{materialName, limit?}): SO SANH GIA giua cac NHA CUNG CAP cho 1 vat tu. Dung khi hoi "mua cho nao re", "ncc nao gia tot".',
    '- cost_overview(args:{period:week|month}): TACH RO 3 LOAI CHI PHI (mua / cap phat / sua ngoai) + tong, kem bien dong vs ky truoc. BAT BUOC dung khi cau hoi chi phi CHUNG CHUNG/MO HO ("chi phi thang nay the nao", "tong chi phi", "thang nay ton bao nhieu") — KHONG tu chon 1 loai roi tra mot so de gay hieu nham.',
    '- compare_cost(args:{period:week|month}): SO SANH chi phi MUA vs CAP PHAT trong ky (2 dong tien khac ban chat). Dung khi hoi "so sanh mua va cap phat", "mua nhieu hay xuat nhieu".',
    '',
    'TOOL LAP KE HOACH & TONG QUAN:',
    '- purchase_suggestion(args:{limit?}): DE XUAT MUA SAM (tu ton duoi dinh muc + tieu hao 30 ngay). Dung khi hoi "nen mua gi", "len ke hoach mua", "can bo sung vat tu nao".',
    '- summary_metrics(): tong quan toan he thong.',
].join('\n');

const VALID_TOOLS = new Set<ToolName>([
    'search_assets',
    'locate_asset',
    'transfer_orders',
    'draft_transfer',
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
    'supply_requests',
    'supply_request_analysis',
    'purchase_requests',
    'purchase_request_analysis',
    'request_lifecycle',
    'request_backlog',
    'request_risk_analysis',
    'purchase_suggestion',
    'cost_variance',
    'cost_overview',
    'compare_cost',
    'summary_metrics',
]);
// Ngan sach suy luan: cau giam doc thuong can ghep nhieu nguon -> cho nhieu luot hon.
const MAX_TOOL_CALLS = 5;
const MAX_ITERATIONS = 10;

// ===== Grounding: mô tả NGUỒN dữ liệu mỗi câu trả lời (để giám đốc tin) =====
const TOOL_LABEL: Record<ToolName, string> = {
    search_assets: 'Máy móc',
    locate_asset: 'Tra cứu máy',
    transfer_orders: 'Lệnh điều chuyển',
    draft_transfer: 'Soạn lệnh điều chuyển',
    top_broken_assets: 'Máy hỏng nhiều',
    low_stock_materials: 'Vật tư sắp hết',
    top_used_materials: 'Vật tư cấp phát nhiều',
    search_materials: 'Danh mục vật tư',
    material_usage_by_plant: 'Cấp phát theo cơ sở',
    purchase_analysis: 'Phân tích mua',
    purchase_orders: 'Đơn hàng mua',
    material_price_history: 'Lịch sử giá',
    supplier_comparison: 'So sánh nhà cung cấp',
    distribution_analysis: 'Chi phí cấp phát',
    supply_requests: 'Phiếu đề xuất cấp',
    supply_request_analysis: 'Phân tích đề xuất cấp',
    purchase_requests: 'Phiếu đề xuất mua',
    purchase_request_analysis: 'Phân tích đề xuất mua',
    request_lifecycle: 'Vòng đời phiếu',
    request_backlog: 'Điểm nghẽn phiếu',
    request_risk_analysis: 'Rủi ro đề xuất',
    purchase_suggestion: 'Đề xuất mua sắm',
    cost_variance: 'Biến động chi phí',
    cost_overview: 'Tổng quan chi phí',
    compare_cost: 'Mua vs Cấp phát',
    summary_metrics: 'Tổng quan hệ thống',
};

type SourceMeta = { tool: string; label: string; module: string; scope?: string; records?: number };

// Lấy "phạm vi" (cơ sở · kỳ) từ kết quả tool đã chạy để hiển thị minh bạch.
const scopeOfRender = (render: ToolOutcome['render']): string | undefined => {
    const a: any = render?.aggregates || {};
    const src =
        a.materialRequests ||
        a.requestAnalysis ||
        a.requestLifecycle ||
        a.requestBacklog ||
        a.requestRiskAnalysis ||
        a.distributionAnalysis ||
        a.usageByPlant ||
        a.purchaseAnalysis ||
        a.priceHistory ||
        a.supplierComparison ||
        a.costOverview ||
        a.compareCost ||
        a.transferOrders ||
        a.variance;
    if (!src) return undefined;
    const parts: string[] = [];
    if (src.plantName) parts.push(String(src.plantName));
    if (src.periodLabel) parts.push(String(src.periodLabel));
    return parts.length ? parts.join(' · ') : undefined;
};

// Sự kiện tiến trình bắn ra trong lúc agent chạy (cho streaming SSE).
export type AgentStep =
    | { type: 'analyze'; tier: 'light' | 'standard' | 'heavy' }
    | { type: 'tool'; tool: string; label: string }
    | { type: 'synthesize' };

// Lõi agent: chạy vòng lặp ReAct, trả về data object. emit() (tuỳ chọn) bắn tiến trình cho streaming.
export const runAssistant = async (messages: AssistantMessage[], emit?: (step: AgentStep) => void) => {
    const startedAt = Date.now();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';
    const feature = tierFor(lastUser);
    emit?.({ type: 'analyze', tier: tierLabelOf(feature) });

    const convo: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let toolCalls = 0;
    let provider = 'fallback';
    let model: string | undefined;
    let lastRender: ToolOutcome['render'] | undefined;
    let answer = '';
    const sources = new Map<string, SourceMeta>();
    const recordSource = (tool: ToolName, render: ToolOutcome['render']) => {
        sources.set(tool, {
            tool,
            label: TOOL_LABEL[tool] || tool,
            module: render?.domain === 'asset' ? 'Máy móc' : render?.domain === 'material' ? 'Vật tư & kho' : render?.domain === 'cost' ? 'Chi phí' : 'Hệ thống',
            scope: scopeOfRender(render),
            records: render?.count || undefined,
        });
    };

    // Pre-route: chạy sẵn tool cho câu rõ ý (chi phí chung chung / so sánh) rồi nạp dữ liệu
    // -> model có số liệu để trả lời ngay, KHÔNG hỏi lại / không tự chọn lệch.
    const forced = forceRoute(lastUser);
    if (forced) {
        try {
            emit?.({ type: 'tool', tool: forced.tool, label: TOOL_LABEL[forced.tool] || forced.tool });
            const outcome = await executeTool(forced.tool, forced.args);
            if (outcome.render) {
                lastRender = outcome.render;
                recordSource(forced.tool, outcome.render);
            }
            toolCalls += 1;
            if (
                [
                    'supply_requests',
                    'supply_request_analysis',
                    'purchase_requests',
                    'purchase_request_analysis',
                    'request_lifecycle',
                    'request_backlog',
                    'request_risk_analysis',
                    'draft_transfer',
                ].includes(forced.tool)
            ) {
                answer = buildDeterministicAnswer(lastRender) || '';
                provider = 'heuristic';
            }
            convo.push({
                role: 'user',
                content: `DU LIEU DA TRUY VAN SAN (${forced.tool}) — HAY DUNG NGAY de tra loi, TUYET DOI khong hoi lai: ${JSON.stringify(outcome.ai).slice(0, 3500)}`,
            });
        } catch {
            /* lỗi tool -> để model tự xử lý như thường */
        }
    }

    for (let i = 0; !answer && i < MAX_ITERATIONS; i += 1) {
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
                    'Tool do khong ton tai. Chi duoc dung: search_assets, locate_asset, transfer_orders, draft_transfer, top_broken_assets, low_stock_materials, top_used_materials, search_materials, material_usage_by_plant, distribution_analysis, supply_requests, supply_request_analysis, purchase_requests, purchase_request_analysis, request_lifecycle, request_backlog, request_risk_analysis, purchase_analysis, purchase_orders, material_price_history, supplier_comparison, purchase_suggestion, cost_variance, cost_overview, compare_cost, summary_metrics. Hay chon tool dung; neu cau hoi ngoai pham vi, tra {"final":"giai thich ngan"}.',
            });
            continue;
        }
        if (!toolName || toolCalls >= MAX_TOOL_CALLS) {
            // hết lượt tool -> ép trả lời từ dữ liệu đã có
            convo.push({ role: 'user', content: 'Da du du lieu (hoac het luot truy van), hay tra ve {"final":...} ngay dua tren cac ket qua tool da co.' });
            continue;
        }

        toolCalls += 1;
        emit?.({ type: 'tool', tool: toolName, label: TOOL_LABEL[toolName] || toolName });
        const outcome = await executeTool(toolName, parsed.args);
        if (outcome.render) {
            lastRender = outcome.render;
            recordSource(toolName, outcome.render);
        }
        convo.push({ role: 'assistant', content: JSON.stringify({ tool: toolName, args: parsed.args }) });
        convo.push({ role: 'user', content: `KET QUA ${toolName}: ${JSON.stringify(outcome.ai).slice(0, 3500)}` });
    }

    // Lưới an toàn: AI không gọi tool nào (trả lời chay / lỗi provider) nhưng câu hỏi rõ ràng cần dữ liệu
    // -> tự định tuyến heuristic, chạy tool thật, và dựng câu trả lời từ số liệu (đáng tin hơn câu chữ AI không grounded).
    if (toolCalls === 0) {
        const guess = classifyIntent(lastUser);
        if (guess) {
            try {
                emit?.({ type: 'tool', tool: guess.tool, label: TOOL_LABEL[guess.tool] || guess.tool });
                const outcome = await executeTool(guess.tool, guess.args);
                if (outcome.render) {
                    lastRender = outcome.render;
                    recordSource(guess.tool, outcome.render);
                }
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
                : 'Mình chưa chắc ý câu hỏi nên chưa truy vấn được dữ liệu phù hợp. Mình tra được: máy & bảo trì (vị trí, hỏng, điều chuyển, QR), vật tư & tồn kho, và chi phí (mua / cấp phát / sửa ngoài, theo cơ sở & theo kỳ). Bạn nêu rõ hơn cơ sở/khoảng thời gian/loại chi phí giúp mình nhé — ví dụ "chi phí mua của Cơ Sở 2 tháng này".');
    }

    emit?.({ type: 'synthesize' });

    const followups = (lastRender as any)?.followups?.filter?.((f: any) => typeof f === 'string') ?? [
        'Máy nào quá hạn bảo trì?',
        'Vì sao chi phí tháng này thay đổi?',
        'Vật tư nào sắp hết?',
    ];

    const sourceList = [...sources.values()];
    // Mức tin cậy: có truy vấn dữ liệu thật + AI grounded = cao; heuristic = trung bình; fallback/không nguồn = thấp/tham khảo.
    const confidence: 'high' | 'medium' | 'low' | 'none' =
        provider === 'fallback'
            ? sourceList.length
                ? 'medium'
                : 'none'
            : provider === 'heuristic'
              ? 'medium'
              : sourceList.length
                ? 'high'
                : 'none';

    // Log gọn để debug (network_error / fallback / câu chậm) — soi theo reqId.
    const reqId = `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const tookMs = Date.now() - startedAt;
    if (provider === 'fallback' || tookMs > 30000) {
        // eslint-disable-next-line no-console
        console.warn(`[ai-assistant ${reqId}] provider=${provider} tools=${toolCalls} took=${tookMs}ms q="${lastUser.slice(0, 120)}"`);
    }

    return {
        domain: lastRender?.domain ?? 'asset',
        answer,
        intent: 'agent',
        count: lastRender?.count ?? 0,
        items: lastRender?.items ?? [],
        aggregates: lastRender?.aggregates ?? {},
        transferDraft: (lastRender?.aggregates as any)?.transferDraft,
        appliedFilters: lastRender?.appliedFilters,
        followups: followups.slice(0, 3),
        sources: sourceList,
        confidence,
        reqId,
        tookMs,
        provider,
        model,
        tier: tierLabelOf(feature),
    };
};

// Endpoint thường (JSON 1 lần) — giữ nguyên hợp đồng cũ.
export const askAgentAssistant = async (req: Request, res: Response) => {
    const messages = (req.body.messages ?? []) as AssistantMessage[];
    const data = await runAssistant(messages);
    return res.status(StatusCodes.OK).json(
        customResponse({ data, message: 'Tro ly da xu ly cau hoi', status: StatusCodes.OK, success: true })
    );
};

// Endpoint STREAMING (SSE): bắn tiến trình "đang phân tích / đang truy vấn <tool> / đang tổng hợp"
// theo thời gian thực, rồi gửi 'done' kèm toàn bộ data. FE đọc bằng fetch + ReadableStream.
export const streamAgentAssistant = async (req: Request, res: Response) => {
    const messages = (req.body.messages ?? []) as AssistantMessage[];
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // tránh proxy (nginx/render) buffer mất tính realtime
    (res as any).flushHeaders?.();

    const send = (event: string, payload: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Tim đập giữ kết nối sống nếu một bước kéo dài (proxy free hay cắt khi im lặng).
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    try {
        send('open', { ok: true });
        const data = await runAssistant(messages, (step) => send('step', step));
        send('done', data);
    } catch {
        send('error', { message: 'Khong xu ly duoc cau hoi' });
    } finally {
        clearInterval(heartbeat);
        res.end();
    }
};
