import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import { NotFoundError } from '@/errors/customError';
import PurchaseRequest from '@/models/PurchaseRequest';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import customResponse from '@/utils/response';

// Trợ lý duyệt thông minh: rà soát 1 phiếu đề xuất mua TRƯỚC KHI DUYỆT.
// Triết lý: cảnh báo tính XÁC ĐỊNH từ DB (giá/SL/NCC/trùng phiếu) — đáng tin, không "ảo giác";
// AI chỉ tóm tắt lại cho gọn. Không phụ thuộc AI để ra quyết định.

type Severity = 'high' | 'medium' | 'info';
type Flag = { severity: Severity; type: string; item?: string; message: string };

const normalize = (v?: unknown) =>
    String(v ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/\s+/g, ' ')
        .trim();

const fmtVnd = (v: number) => `${Math.round(v).toLocaleString('vi-VN')}đ`;
const median = (nums: number[]) => {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};

// Cùng vật tư: ưu tiên materialId, fallback so tên đã chuẩn hoá.
const sameMaterial = (a: any, b: any) => {
    if (a.materialId && b.materialId) return String(a.materialId) === String(b.materialId);
    const an = normalize(a.materialName);
    const bn = normalize(b.materialName);
    return Boolean(an) && an === bn;
};

const ACTIVE_HISTORY_STATUSES = [
    'approved',
    'ordered',
    'received',
    'pending',
    'in_progress',
    'partially_distributed',
    'distributed',
];

export const reviewPurchaseRequest = async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const request = await PurchaseRequest.findOne({ _id: id, isDeleted: { $ne: true } })
        .populate('plantId', 'name code')
        .lean();
    if (!request) throw new NotFoundError('Không tìm thấy phiếu đề xuất mua');

    const items = ((request as any).items || []) as any[];
    const materialIds = items
        .map((i) => i.materialId)
        .filter(Boolean)
        .map((mid: any) => new Types.ObjectId(String(mid)));

    // Lịch sử 1 năm gần đây các phiếu khác có chứa vật tư liên quan (để so giá/SL/NCC/trùng).
    const since = new Date(Date.now() - 365 * 86400000);
    const orConds: any[] = [];
    if (materialIds.length) orConds.push({ 'items.materialId': { $in: materialIds } });
    const names = items.map((i) => i.materialName).filter(Boolean);
    if (names.length) orConds.push({ 'items.materialName': { $in: names } });

    const history = orConds.length
        ? ((await PurchaseRequest.find({
              _id: { $ne: (request as any)._id },
              isDeleted: { $ne: true },
              status: { $in: ACTIVE_HISTORY_STATUSES },
              createdAt: { $gte: since },
              $or: orConds,
          })
              .select('requestCode status createdAt items')
              .sort({ createdAt: -1 })
              .limit(600)
              .lean()) as any[])
        : [];

    const flags: Flag[] = [];
    const dupByCode = new Map<string, Set<string>>();

    for (const item of items) {
        const hist: Array<{ price: number; qty: number; supplier?: string }> = [];
        for (const h of history) {
            for (const hi of h.items || []) {
                if (sameMaterial(hi, item)) {
                    hist.push({
                        price: Number(hi.unitPrice || 0),
                        qty: Number(hi.quantityRequested || 0),
                        supplier: hi.supplierName,
                    });
                }
            }
            // Trùng phiếu: phiếu gần đây (<=45 ngày) còn chờ duyệt/đã duyệt mà trùng vật tư.
            if (['pending', 'approved'].includes(h.status)) {
                const ageDays = (Date.now() - new Date(h.createdAt).getTime()) / 86400000;
                if (ageDays <= 45 && (h.items || []).some((hi: any) => sameMaterial(hi, item))) {
                    const set = dupByCode.get(h.requestCode) || new Set<string>();
                    set.add(item.materialName || 'vật tư');
                    dupByCode.set(h.requestCode, set);
                }
            }
        }

        const price = Number(item.unitPrice || 0);
        const prices = hist.map((h) => h.price).filter((p) => p > 0);
        if (price > 0 && prices.length) {
            const med = median(prices);
            if (med > 0) {
                const diff = (price - med) / med;
                if (diff >= 0.25) {
                    flags.push({
                        severity: diff >= 0.5 ? 'high' : 'medium',
                        type: 'price_high',
                        item: item.materialName,
                        message: `Đơn giá ${fmtVnd(price)} cao hơn ~${Math.round(diff * 100)}% so với giá thường mua (~${fmtVnd(med)}).`,
                    });
                } else if (diff <= -0.4) {
                    flags.push({
                        severity: 'medium',
                        type: 'price_low',
                        item: item.materialName,
                        message: `Đơn giá ${fmtVnd(price)} thấp bất thường so với giá thường (~${fmtVnd(med)}) — kiểm tra nhập sai?`,
                    });
                }
            }
        }

        const qty = Number(item.quantityRequested || 0);
        const qtys = hist.map((h) => h.qty).filter((q) => q > 0);
        if (qty > 0 && qtys.length >= 2) {
            const medQ = median(qtys);
            if (medQ > 0 && qty >= medQ * 3) {
                flags.push({
                    severity: 'medium',
                    type: 'qty_high',
                    item: item.materialName,
                    message: `Số lượng ${qty} cao gấp ${(qty / medQ).toFixed(1)}× mức thường mua (~${medQ}).`,
                });
            }
        }

        if (item.supplierName && hist.length >= 2) {
            const known = hist.some((h) => normalize(h.supplier) === normalize(item.supplierName));
            if (!known) {
                flags.push({
                    severity: 'info',
                    type: 'supplier_new',
                    item: item.materialName,
                    message: `Nhà cung cấp "${item.supplierName}" chưa từng dùng cho vật tư này.`,
                });
            }
        }
    }

    for (const [code, mats] of dupByCode) {
        flags.push({
            severity: 'medium',
            type: 'duplicate',
            message: `Có thể trùng với phiếu ${code} (chung: ${[...mats].slice(0, 3).join(', ')}${mats.size > 3 ? '…' : ''}).`,
        });
    }

    const highCount = flags.filter((f) => f.severity === 'high').length;
    const medCount = flags.filter((f) => f.severity === 'medium').length;
    const overall: 'ok' | 'review' | 'warn' = highCount > 0 ? 'warn' : medCount > 0 ? 'review' : 'ok';

    // AI tóm tắt (rẻ, không bắt buộc): diễn giải các cảnh báo đã tính cho giám đốc.
    let summary = '';
    try {
        const ai = await aiProviderService.generateText({
            feature: 'approval-review',
            temperature: 0.2,
            maxTokens: 400,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban la tro ly duyet mua vat tu cua cong ty may. Tom tat NGAN GON (2-4 cau) cac diem can luu y cho giam doc truoc khi duyet, dua TREN cac canh bao da cho. Neu khong co canh bao, noi phieu khong phat hien bat thuong va co the duyet. Tieng Viet, khong markdown, khong bia them.',
                },
                {
                    role: 'user',
                    content: `Phieu ${(request as any).requestCode}: ${items.length} dong, tong ${fmtVnd(Number((request as any).totalWithVat || 0))}.\nCanh bao da phat hien:\n${
                        flags.map((f) => `- [${f.severity}] ${f.item ? f.item + ': ' : ''}${f.message}`).join('\n') ||
                        '(khong co canh bao nao)'
                    }`,
                },
            ],
        });
        summary = ai.content.trim();
    } catch {
        summary =
            overall === 'ok'
                ? 'Không phát hiện bất thường rõ rệt — phiếu có thể duyệt.'
                : 'Có một số điểm cần lưu ý, xem danh sách cảnh báo bên dưới.';
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                requestCode: (request as any).requestCode,
                overall,
                flags,
                summary,
                checkedItems: items.length,
                historyDepth: history.length,
            },
            message: 'Đã rà soát phiếu',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
