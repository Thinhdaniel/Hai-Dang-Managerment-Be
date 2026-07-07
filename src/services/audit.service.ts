import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { CronJob } from 'cron';
import { format, subDays } from 'date-fns';
import { z } from 'zod';
import Asset from '@/models/Asset';
import QrLabel from '@/models/QrLabel';
import Transfer from '@/models/Transfer';
import AssetDisposalItem from '@/models/AssetDisposalItem';
import InventoryStock from '@/models/InventoryStock';
import User from '@/models/User';
import AiAudit from '@/models/AiAudit';
import { ASSET_STATUS } from '@/constant/assetStatus';
import { ASSET_DISPOSAL_ITEM_STATUS } from '@/constant/assetDisposal';
import { QR_LABEL_STATUS } from '@/constant/qrLabel';
import { ROLE_GROUPS } from '@/constant/permissions';
import { AI_FEATURES } from '@/constant/aiModels';
import { dashboardRepository } from '@/repositories/dashboard.repository';
import { notifyUser } from '@/services/notification.helper';
import { aiProviderService, extractJsonObject, type AiChatMessage } from '@/services/ai/ai-provider.service';
import { vertexProviderService } from '@/services/ai/vertex-provider.service';
import customResponse from '@/utils/response';

type Severity = 'critical' | 'warning' | 'info';

type AuditFinding = {
    code: string;
    source: 'rule' | 'ai';
    severity: Severity;
    title: string;
    detail: string;
    refs: string[];
};

const FINAL_DISPOSAL_ITEM_STATUSES = [
    ASSET_DISPOSAL_ITEM_STATUS.DISPOSED,
    ASSET_DISPOSAL_ITEM_STATUS.KEPT,
    ASSET_DISPOSAL_ITEM_STATUS.CANCELLED,
];

const assetLabel = (a: any) => a?.machineCode || a?.name || String(a?._id ?? '');

// ===== Rule-check cứng: chạy trong code, không qua AI nên không bao giờ "ảo giác" =====

// Bài học 2026-07-07: 2 tem QR cùng trỏ 1 máy nằm trong DB 2 tuần mới bị phát hiện thủ công.
const checkMultiLabelAssets = async (): Promise<AuditFinding[]> => {
    const rows = await QrLabel.aggregate([
        { $match: { isDeleted: { $ne: true }, assetId: { $ne: null } } },
        { $group: { _id: '$assetId', labels: { $push: { publicId: '$publicId', status: '$status' } } } },
        { $match: { 'labels.1': { $exists: true } } },
        { $lookup: { from: 'assets', localField: '_id', foreignField: '_id', as: 'asset' } },
        { $unwind: { path: '$asset', preserveNullAndEmptyArrays: true } },
    ]);
    const findings: AuditFinding[] = [];
    for (const row of rows) {
        const assigned = row.labels.filter((l: any) => l.status === QR_LABEL_STATUS.ASSIGNED);
        const others = row.labels.filter((l: any) => l.status !== QR_LABEL_STATUS.ASSIGNED);
        const code = assetLabel(row.asset);
        if (assigned.length > 1) {
            findings.push({
                code: 'multi_assigned_label',
                source: 'rule',
                severity: 'critical',
                title: `Máy ${code} có ${assigned.length} tem QR cùng đang gắn`,
                detail: `Các tem ${assigned.map((l: any) => l.publicId).join(', ')} cùng trỏ về 1 máy — quét sẽ nhận nhầm máy. Cần thu hồi tem thừa.`,
                refs: [code, ...assigned.map((l: any) => l.publicId)],
            });
        } else if (others.length) {
            findings.push({
                code: 'retired_label_remains',
                source: 'rule',
                severity: 'info',
                title: `Máy ${code} còn ${others.length} tem cũ đã thay thế`,
                detail: `Tem cũ (${others.map((l: any) => l.publicId).join(', ')}) có thể vẫn dán trên máy ngoài xưởng — nên bóc bỏ để tránh quét nhầm.`,
                refs: [code, ...others.map((l: any) => l.publicId)],
            });
        }
    }
    return findings;
};

const checkDuplicateIdentity = async (): Promise<AuditFinding[]> => {
    const findings: AuditFinding[] = [];
    const dupFields: Array<{ field: 'serial' | 'machineCode'; label: string }> = [
        { field: 'serial', label: 'số serial' },
        { field: 'machineCode', label: 'mã máy' },
    ];
    for (const { field, label } of dupFields) {
        const rows = await Asset.aggregate([
            { $match: { isDeleted: { $ne: true }, [field]: { $nin: [null, ''] } } },
            { $group: { _id: `$${field}`, count: { $sum: 1 }, codes: { $push: '$machineCode' } } },
            { $match: { count: { $gt: 1 } } },
            { $limit: 10 },
        ]);
        for (const row of rows) {
            findings.push({
                code: `duplicate_${field}`,
                source: 'rule',
                severity: 'warning',
                title: `${row.count} máy trùng ${label} "${row._id}"`,
                detail: `Các máy ${row.codes.filter(Boolean).join(', ')} đang dùng chung ${label} — dễ tra cứu/quét nhầm hồ sơ.`,
                refs: row.codes.filter(Boolean),
            });
        }
    }
    return findings;
};

const checkStaleTransfers = async (): Promise<AuditFinding[]> => {
    const findings: AuditFinding[] = [];
    const stalePending = await Transfer.find({
        isDeleted: { $ne: true },
        status: 'pending',
        createdAt: { $lt: subDays(new Date(), 7) },
    })
        .populate('fromPlantId toPlantId')
        .limit(10)
        .lean();
    for (const t of stalePending as any[]) {
        const ref = `TRF-${String(t._id).slice(-4).toUpperCase()}`;
        findings.push({
            code: 'stale_pending_transfer',
            source: 'rule',
            severity: 'warning',
            title: `Lệnh điều chuyển ${ref} chờ duyệt quá 7 ngày`,
            detail: `Tạo ${format(new Date(t.createdAt), 'dd/MM')} từ ${t.fromPlantId?.name || '?'} → ${t.toPlantId?.name || '?'}, vẫn chưa được duyệt/từ chối.`,
            refs: [ref],
        });
    }
    const staleApproved = await Transfer.find({
        isDeleted: { $ne: true },
        status: 'approved',
        updatedAt: { $lt: subDays(new Date(), 3) },
    })
        .populate('fromPlantId toPlantId')
        .limit(10)
        .lean();
    for (const t of staleApproved as any[]) {
        const ref = `TRF-${String(t._id).slice(-4).toUpperCase()}`;
        findings.push({
            code: 'stale_approved_transfer',
            source: 'rule',
            severity: 'warning',
            title: `Lệnh ${ref} đã duyệt quá 3 ngày chưa hoàn tất`,
            detail: `Máy trên đường ${t.fromPlantId?.name || '?'} → ${t.toPlantId?.name || '?'} — kiểm tra máy đã đến nơi chưa và bấm hoàn tất.`,
            refs: [ref],
        });
    }
    return findings;
};

// Máy treo trạng thái "chuẩn bị thanh lý" nhưng không nằm trong đợt thanh lý mở nào (mồ côi).
const checkDisposalMismatch = async (): Promise<AuditFinding[]> => {
    const pendingAssets = await Asset.find({ isDeleted: { $ne: true }, status: ASSET_STATUS.PENDING_DISPOSAL })
        .select('machineCode name')
        .lean();
    if (!pendingAssets.length) return [];
    const openItems = await AssetDisposalItem.find({
        isDeleted: { $ne: true },
        status: { $nin: FINAL_DISPOSAL_ITEM_STATUSES },
        assetId: { $in: pendingAssets.map((a) => a._id) },
    })
        .select('assetId')
        .lean();
    const covered = new Set(openItems.map((i) => String(i.assetId)));
    const orphans = pendingAssets.filter((a) => !covered.has(String(a._id)));
    if (!orphans.length) return [];
    return [
        {
            code: 'orphan_pending_disposal',
            source: 'rule',
            severity: 'warning',
            title: `${orphans.length} máy treo trạng thái "chuẩn bị thanh lý"`,
            detail: `Các máy ${orphans
                .slice(0, 8)
                .map(assetLabel)
                .join(', ')}${orphans.length > 8 ? '…' : ''} đang ở trạng thái chuẩn bị thanh lý nhưng không nằm trong đợt thanh lý mở nào — có thể do đợt cũ bị hủy mà máy chưa được trả về trạng thái thường.`,
            refs: orphans.slice(0, 8).map(assetLabel),
        },
    ];
};

const checkNegativeStock = async (): Promise<AuditFinding[]> => {
    // Cast any: type inference của model này lệch do timestamps đổi tên (updatedAt -> lastUpdated)
    const rows = await InventoryStock.find({ isDeleted: { $ne: true }, currentStock: { $lt: 0 } } as any)
        .populate('materialId plantId')
        .limit(10)
        .lean();
    return (rows as any[]).map((r) => ({
        code: 'negative_stock',
        source: 'rule' as const,
        severity: 'critical' as const,
        title: `Tồn kho âm: ${r.materialId?.name || '?'} tại ${r.plantId?.name || '?'}`,
        detail: `Số tồn hiện tại ${r.currentStock} — dữ liệu nhập/xuất đang lệch, cần kiểm kê lại vật tư này.`,
        refs: [r.materialId?.name].filter(Boolean),
    }));
};

const checkMislocated = async (): Promise<AuditFinding[]> => {
    const rows = await dashboardRepository.getMislocatedAssets(50);
    if (!rows.length) return [];
    const codes = rows.slice(0, 8).map((r: any) => r.machineCode || r.name);
    return [
        {
            code: 'gps_mislocated',
            source: 'rule',
            severity: rows.length >= 5 ? 'warning' : 'info',
            title: `${rows.length} máy quét GPS lệch cơ sở`,
            detail: `Vị trí quét gần nhất khác cơ sở trên hồ sơ: ${codes.join(', ')}${rows.length > 8 ? '…' : ''} — máy bị chuyển đi mà không làm lệnh điều chuyển?`,
            refs: codes,
        },
    ];
};

const checkOverdueMaintenance = async (): Promise<AuditFinding[]> => {
    const overdue = await dashboardRepository.getOverdueTickets(14, 8);
    if (!overdue.count) return [];
    return [
        {
            code: 'overdue_maintenance',
            source: 'rule',
            severity: overdue.count >= 3 ? 'warning' : 'info',
            title: `${overdue.count} phiếu bảo trì mở quá 14 ngày`,
            detail: 'Phiếu treo lâu thường là máy đã sửa xong nhưng quên đóng phiếu, hoặc máy hỏng nặng bị bỏ quên.',
            refs: [],
        },
    ];
};

// ===== Dataset rút gọn cho AI (chỉ số liệu thật, không kèm dữ liệu nhạy cảm) =====
const buildAiDataset = async () => {
    const [assetByPlant, transfers30d, stockMoves7d] = await Promise.all([
        Asset.aggregate([
            { $match: { isDeleted: { $ne: true } } },
            { $group: { _id: { plantId: '$plantId', status: '$status' }, count: { $sum: 1 } } },
            { $lookup: { from: 'plants', localField: '_id.plantId', foreignField: '_id', as: 'plant' } },
            { $unwind: { path: '$plant', preserveNullAndEmptyArrays: true } },
            { $project: { _id: 0, plant: '$plant.name', status: '$_id.status', count: 1 } },
        ]),
        Transfer.aggregate([
            { $match: { isDeleted: { $ne: true }, createdAt: { $gte: subDays(new Date(), 30) } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        InventoryStock.aggregate([
            { $match: { isDeleted: { $ne: true } } },
            { $group: { _id: null, total: { $sum: 1 }, zeroOrLess: { $sum: { $cond: [{ $lte: ['$currentStock', 0] }, 1, 0] } } } },
        ]),
    ]);
    return { assetByPlant, transfers30d, stockSummary: stockMoves7d[0] ?? {} };
};

const aiResponseSchema = z.object({
    summary: z.string().max(1500),
    extraFindings: z
        .array(
            z.object({
                severity: z.enum(['critical', 'warning', 'info']).default('info'),
                title: z.string().max(200),
                detail: z.string().max(500),
                refs: z.array(z.string().max(60)).max(8).default([]),
            })
        )
        .max(5)
        .default([]),
    recommendations: z.array(z.string().max(300)).max(5).default([]),
});

const AUDIT_SYSTEM = [
    'Ban la KIEM TOAN VIEN van hanh cho cong ty may. Nhiem vu: doc (1) danh sach phat hien tu rule-check va (2) so lieu tong hop, roi:',
    '- Viet "summary": nhan dinh tong quan 3-5 cau tieng Viet cho giam doc, uu tien noi ve phat hien nghiem trong nhat.',
    '- "extraFindings": TOI DA 5 bat thuong MOI nhin thay tu so lieu tong hop ma rule-check CHUA neu (vd: co so co ty le may bao tri cao bat thuong, lech co cau may giua cac co so). KHONG lap lai phat hien rule-check. Khong chac thi de trong.',
    '- "recommendations": toi da 5 viec nen lam, cu the, ngan gon.',
    'TUYET DOI khong bia so lieu/ma may khong co trong du lieu. Tra ve DUY NHAT JSON: {"summary":"...","extraFindings":[{"severity":"warning","title":"...","detail":"...","refs":[]}],"recommendations":["..."]}',
].join('\n');

const runAiAnalysis = async (ruleFindings: AuditFinding[], dataset: unknown) => {
    const messages: AiChatMessage[] = [
        { role: 'system', content: AUDIT_SYSTEM },
        {
            role: 'user',
            content: JSON.stringify({
                ruleFindings: ruleFindings.map(({ severity, title, detail }) => ({ severity, title, detail })),
                dataset,
            }),
        },
    ];
    // Ưu tiên Vertex (gemini-2.5-pro, credit GCP); lỗi thì rớt về chuỗi 9router như các tác vụ khác.
    try {
        const result = await vertexProviderService.generateJson<unknown>({
            messages,
            model: 'gemini-2.5-pro',
            temperature: 0.2,
            maxTokens: 4096,
            reasoningEffort: 'medium',
            timeoutMs: 120_000,
        });
        return { parsed: aiResponseSchema.parse(result.data), provider: result.provider, model: result.model };
    } catch (error) {
        console.warn('[Audit] Vertex lỗi, rớt về 9router:', error instanceof Error ? error.message : error);
    }
    const result = await aiProviderService.generateJson<unknown>({
        messages,
        feature: AI_FEATURES.AUDIT,
        temperature: 0.2,
        maxTokens: 2000,
        timeoutMs: 120_000,
    });
    return {
        parsed: aiResponseSchema.parse(JSON.parse(extractJsonObject(result.content))),
        provider: result.provider,
        model: result.model,
    };
};

// ===== Chạy 1 phiên kiểm toán =====
export const runAudit = async (trigger: 'cron' | 'manual', generatedBy?: string) => {
    const checks = await Promise.all([
        checkMultiLabelAssets(),
        checkDuplicateIdentity(),
        checkStaleTransfers(),
        checkDisposalMismatch(),
        checkNegativeStock(),
        checkMislocated(),
        checkOverdueMaintenance(),
    ]);
    const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
    const findings = checks.flat().sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

    let summary = '';
    let recommendations: string[] = [];
    let provider = 'fallback';
    let model: string | undefined;

    try {
        const dataset = await buildAiDataset();
        const ai = await runAiAnalysis(findings, dataset);
        summary = ai.parsed.summary;
        recommendations = ai.parsed.recommendations;
        provider = ai.provider;
        model = ai.model;
        for (const f of ai.parsed.extraFindings) {
            findings.push({ code: 'ai', source: 'ai', ...f });
        }
    } catch (error) {
        // AI lỗi -> vẫn lưu kết quả rule-check (giá trị chính nằm ở đây).
        console.error('[Audit] AI phân tích thất bại:', error instanceof Error ? error.message : error);
        const critical = findings.filter((f) => f.severity === 'critical').length;
        const warning = findings.filter((f) => f.severity === 'warning').length;
        summary = findings.length
            ? `Rà soát tự động phát hiện ${findings.length} điểm cần chú ý (${critical} nghiêm trọng, ${warning} cảnh báo).`
            : 'Rà soát tự động không phát hiện bất thường nào.';
    }

    const runKey = format(new Date(), 'yyyy-MM-dd');
    const doc = await AiAudit.findOneAndUpdate(
        { runKey },
        {
            $set: {
                runKey,
                runAt: new Date(),
                trigger,
                summary,
                findings,
                recommendations,
                stats: {
                    total: findings.length,
                    critical: findings.filter((f) => f.severity === 'critical').length,
                    warning: findings.filter((f) => f.severity === 'warning').length,
                    info: findings.filter((f) => f.severity === 'info').length,
                },
                provider,
                model,
                generatedBy: generatedBy || undefined,
            },
        },
        { upsert: true, new: true }
    );
    return doc;
};

const notifyDirectors = async (audit: any) => {
    const actionable = (audit.stats?.critical ?? 0) + (audit.stats?.warning ?? 0);
    if (!actionable) return; // đêm yên bình thì không làm phiền
    const directors = await User.find({
        role: { $in: [...ROLE_GROUPS.DIRECTOR_UP] },
        isDeleted: { $ne: true },
        isActive: true,
    }).select('_id');
    const top = audit.findings?.find((f: any) => f.severity !== 'info');
    for (const d of directors) {
        await notifyUser(String(d._id), 'notify:new', {
            title: `Kiểm toán đêm: ${audit.stats.critical} nghiêm trọng, ${audit.stats.warning} cảnh báo`,
            message: top?.title || audit.summary?.slice(0, 160) || '',
            type: audit.stats.critical > 0 ? 'error' : 'warning',
            actionType: 'ai-audit',
            actionId: String(audit._id),
        });
    }
};

// ===== Cron 03:30 sáng VN hằng ngày =====
export const startAuditSchedule = () => {
    CronJob.from({
        cronTime: '0 30 3 * * *',
        onTick: () =>
            void (async () => {
                try {
                    const doc = await runAudit('cron');
                    await notifyDirectors(doc);
                    console.log(`[Audit] Kiểm toán đêm xong: ${doc.stats?.total ?? 0} phát hiện`);
                } catch (error) {
                    console.error('[Audit] Kiểm toán đêm thất bại:', error);
                }
            })(),
        start: true,
        timeZone: 'Asia/Ho_Chi_Minh',
    });
    console.log('[Audit] Đã lên lịch kiểm toán đêm (03:30 hằng ngày).');
};

// ===== HTTP =====
export const getLatestAudit = async (_req: Request, res: Response) => {
    const doc = await AiAudit.findOne().sort({ runKey: -1 }).lean();
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Kiem toan moi nhat', status: StatusCodes.OK, success: true }));
};

export const listAudits = async (_req: Request, res: Response) => {
    const docs = await AiAudit.find().sort({ runKey: -1 }).limit(14).lean();
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: docs, message: 'Danh sach kiem toan', status: StatusCodes.OK, success: true }));
};

export const runAuditNow = async (req: Request, res: Response) => {
    const doc = await runAudit('manual', req.userId);
    return res
        .status(StatusCodes.OK)
        .json(customResponse({ data: doc, message: 'Da chay kiem toan', status: StatusCodes.OK, success: true }));
};
