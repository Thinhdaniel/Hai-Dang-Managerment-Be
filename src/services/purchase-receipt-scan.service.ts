import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { AI_FEATURES } from '@/constant/aiModels';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseReceiptScan from '@/models/PurchaseReceiptScan';
import PurchaseShortage from '@/models/PurchaseShortage';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { getUserPlantId, toId } from '@/services/material-workflow.helpers';
import customResponse from '@/utils/response';
import { serializePurchaseShortage } from '@/utils/materialSerializers';

type ReceiptOcrLine = {
    pageIndex?: number;
    lineNo?: number;
    materialName: string;
    unit?: string;
    quantity?: number;
    unitPrice?: number;
    vatRate?: number;
    supplierName?: string;
    note?: string;
    rawText?: string;
    confidence?: number;
};

type ReceiptOcrResult = {
    header?: {
        supplierName?: string | null;
        invoiceNo?: string | null;
        deliveryCode?: string | null;
        invoiceDate?: string | null;
        receivedDate?: string | null;
    };
    lines?: ReceiptOcrLine[];
};

const cleanText = (value: unknown): string | undefined => {
    const text = String(value ?? '').trim();
    return text && text.toLowerCase() !== 'null' ? text : undefined;
};

const cleanNumber = (value: unknown): number | undefined => {
    if (value == null || value === '') return undefined;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
    const raw = String(value).trim();
    if (!raw) return undefined;
    const normalized = raw
        .replace(/[^\d,.-]/g, '')
        .replace(/\.(?=\d{3}(\D|$))/g, '')
        .replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const normalizeText = (value: unknown) =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

const tokenSet = (value: unknown) => new Set(normalizeText(value).split(/\s+/).filter(Boolean));

const similarity = (a: unknown, b: unknown) => {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.88;
    const ta = tokenSet(na);
    const tb = tokenSet(nb);
    if (!ta.size || !tb.size) return 0;
    let intersection = 0;
    ta.forEach((token) => {
        if (tb.has(token)) intersection += 1;
    });
    return intersection / Math.max(ta.size, tb.size);
};

const sameSupplier = (a?: string, b?: string) => {
    if (!a || !b) return true;
    return similarity(a, b) >= 0.72;
};

const sameUnit = (a?: string, b?: string) => {
    if (!a || !b) return true;
    return normalizeText(a) === normalizeText(b) || similarity(a, b) >= 0.78;
};

/**
 * Token chứa chữ số (kích cỡ/mã: "11/75", "8/60", "30x60x1.4"…) phải khớp tuyệt đối.
 * "Kim DBx1# 11/75" và "Kim DBx1# 8/60" giống nhau về chữ nhưng là 2 loại kim khác hẳn —
 * nếu tập token-số của 2 bên xung đột thì CẤM khớp, kể cả tên tương đồng cao.
 */
const numericTokens = (value: unknown) =>
    normalizeText(value)
        .split(/\s+/)
        .filter((token) => /\d/.test(token));

const numbersConflict = (a: unknown, b: unknown) => {
    const ta = numericTokens(a);
    const tb = numericTokens(b);
    if (!ta.length || !tb.length) return false;
    const setA = new Set(ta);
    const setB = new Set(tb);
    const aInB = ta.every((token) => setB.has(token));
    const bInA = tb.every((token) => setA.has(token));
    return !(aInB || bInA);
};

/** Ngưỡng tự điền: dưới ngưỡng này AI chỉ được GỢI Ý, người dùng phải tự xác nhận. */
const AUTO_LINE_CONFIDENCE = 0.75;
const AUTO_NAME_SIMILARITY = 0.9;

const roundQty = (value: number) => Number(value.toFixed(2));

const ensureOrderScope = (req: Request, order: any) => {
    if (req.role === 'admin') return;
    const userPlantId = getUserPlantId(req);
    const orderPlantId = toId(order?.plantId);
    if (!userPlantId || !orderPlantId || userPlantId !== orderPlantId) {
        throw new BadRequestError('Ban chi co the xem don hang cua co so minh');
    }
};

const buildReceiptOcrPrompt = () =>
    [
        'Ban la tro ly OCR phieu giao hang/hoa don nhan hang vat tu cua cong ty may.',
        'Doc 1 hoac nhieu anh. Anh co the la phieu NCC in san, anh chup Excel, anh chup bang ke, hoac co chu viet tay.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'QUY TAC SO 1 - TUYET DOI KHONG DOAN: ky tu/chu so nao mo, nhoe, bi che, khong doc chac chan thi KHONG duoc tu suy ra.',
        '- So luong khong doc ro -> quantity: null (KHONG doan mot con so gan giong).',
        '- Ten hang doc duoc mot phan -> ghi phan doc duoc, confidence thap.',
        '- MOI dong deu phai co rawText: chep NGUYEN VAN ca dong nhin thay tren anh (ke ca ky tu la), de nguoi kiem tra lai.',
        'confidence tu 0 den 1 cho tung dong, cham diem TRUNG THUC: in ro net moi cho >= 0.9; chu viet tay/mo/nghieng/thieu net -> 0.5-0.7; rat mo/doan mot phan -> < 0.5.',
        'Muc tieu la lay SO LUONG GIAO THUC TE/so luong nhan, khong lay so luong can neu co ca hai cot.',
        'Uu tien cac cot: Ten hang/Ten vat tu/Hang hoa, DVT/Don vi, SL giao/So luong/SL nhan, Don gia, VAT, Ghi chu.',
        'Neu co nhieu anh la nhieu trang cua cung mot phieu, gop cac dong theo thu tu anh va pageIndex bat dau tu 0.',
        'Bo qua dong tong cong, chiet khau, thanh toan, chu ky, tieu de bang.',
        'So luong va tien tra ve so thuan, khong dau phan cach nghin. Vi du "1.200" -> 1200, "12,5" -> 12.5.',
        'Ngay tra ISO YYYY-MM-DD neu doc duoc.',
        'Output schema:',
        '{"header":{"supplierName":null,"invoiceNo":null,"deliveryCode":null,"invoiceDate":null,"receivedDate":null},"lines":[{"pageIndex":0,"lineNo":1,"materialName":"","unit":null,"quantity":null,"unitPrice":null,"vatRate":null,"supplierName":null,"note":null,"rawText":null,"confidence":0.8}]}',
    ].join('\n');

const normalizeOcrLines = (raw: ReceiptOcrResult): ReceiptOcrLine[] =>
    (Array.isArray(raw?.lines) ? raw.lines : [])
        .map((line, index) => ({
            pageIndex: cleanNumber(line.pageIndex) ?? 0,
            lineNo: cleanNumber(line.lineNo) ?? index + 1,
            materialName: cleanText(line.materialName) || '',
            unit: cleanText(line.unit),
            quantity: cleanNumber(line.quantity),
            unitPrice: cleanNumber(line.unitPrice),
            vatRate: cleanNumber(line.vatRate),
            supplierName: cleanText(line.supplierName),
            note: cleanText(line.note),
            rawText: cleanText(line.rawText),
            confidence: Math.min(1, Math.max(0, cleanNumber(line.confidence) ?? 0.65)),
        }))
        // KHÔNG vứt dòng thiếu SL/tên — dòng đọc dở dang phải hiện cho người kiểm tra (unreadableLines)
        .filter((line) => line.materialName || line.rawText);

type VerifyStatus = 'agreed' | 'quantity_mismatch' | 'only_first' | 'only_second';
type VerifiedLine = ReceiptOcrLine & { verify?: VerifyStatus; verifyNote?: string };

/**
 * Đối chiếu 2 lần đọc ĐỘC LẬP (2 model khác dòng). Cùng dòng + cùng SL/ĐVT -> nâng tin cậy;
 * lệch số -> hạ tin cậy + ghi rõ 2 giá trị; dòng chỉ 1 bên thấy -> hạ tin cậy, bắt người rà.
 */
const reconcileScans = (first: ReceiptOcrLine[], second: ReceiptOcrLine[]): VerifiedLine[] => {
    const used = new Set<number>();
    const out: VerifiedLine[] = [];
    for (const line of first) {
        let bestIdx = -1;
        let bestSim = 0;
        second.forEach((cand, idx) => {
            if (used.has(idx)) return;
            if (numbersConflict(line.materialName, cand.materialName)) return;
            const sim = similarity(line.materialName, cand.materialName);
            if (sim > bestSim) {
                bestSim = sim;
                bestIdx = idx;
            }
        });
        if (bestIdx >= 0 && bestSim >= 0.72) {
            used.add(bestIdx);
            const cand = second[bestIdx];
            const sameQty = Number(cand.quantity ?? -1) === Number(line.quantity ?? -2);
            if (sameQty && sameUnit(line.unit, cand.unit)) {
                out.push({ ...line, confidence: Math.max(line.confidence ?? 0.65, 0.92), verify: 'agreed' });
            } else {
                out.push({
                    ...line,
                    confidence: Math.min(line.confidence ?? 0.65, 0.5),
                    verify: 'quantity_mismatch',
                    verifyNote: `2 lần đọc lệch nhau: lần 1 ${line.quantity ?? '?'} ${line.unit || ''} · lần 2 ${cand.quantity ?? '?'} ${cand.unit || ''}`,
                });
            }
        } else {
            out.push({
                ...line,
                confidence: Math.min(line.confidence ?? 0.65, 0.6),
                verify: 'only_first',
                verifyNote: 'Lần đọc 2 không thấy dòng này — cần đối chiếu ảnh gốc',
            });
        }
    }
    second.forEach((cand, idx) => {
        if (used.has(idx)) return;
        out.push({
            ...cand,
            confidence: Math.min(cand.confidence ?? 0.65, 0.6),
            verify: 'only_second',
            verifyNote: 'Chỉ lần đọc 2 thấy dòng này — cần đối chiếu ảnh gốc',
        });
    });
    return out;
};

const getUploadedImages = (req: Request) => {
    const files = Array.isArray(req.files)
        ? req.files
        : req.file
          ? [req.file]
          : req.files && typeof req.files === 'object'
            ? Object.values(req.files).flat()
            : [];
    return files as Express.Multer.File[];
};

const runOcrPass = async (files: Express.Multer.File[], feature: string) => {
    const content = [
        { type: 'text' as const, text: buildReceiptOcrPrompt() },
        ...files.map((file) => ({
            type: 'image_url' as const,
            image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` },
        })),
    ];

    return aiProviderService.generateJson<ReceiptOcrResult>({
        feature,
        temperature: 0.05,
        reasoningEffort: 'low',
        maxTokens: 16000,
        timeoutMs: 90000,
        messages: [
            {
                role: 'system',
                content:
                    'Ban trich xuat du lieu co cau truc tu anh phieu giao hang/hoa don nhan hang. Chi tra JSON hop le. Khong duoc doan ky tu khong doc ro.',
            },
            { role: 'user', content },
        ],
    });
};

/**
 * Đọc 2 LẦN ĐỘC LẬP bằng 2 model khác dòng (gemini + gpt) chạy song song rồi đối chiếu.
 * Ưu tiên độ chính xác hơn tốc độ: dòng nào 2 lần đọc không thống nhất sẽ KHÔNG được tự điền.
 * Lần 2 lỗi (model bận/hết quota) thì vẫn chạy tiếp 1 lần đọc, nhưng đánh dấu chưa đối chiếu.
 */
const scanReceiptImages = async (files: Express.Multer.File[]) => {
    const [primary, verifyResult] = await Promise.allSettled([
        runOcrPass(files, AI_FEATURES.OCR_PURCHASE_RECEIPT),
        runOcrPass(files, AI_FEATURES.OCR_PURCHASE_RECEIPT_VERIFY),
    ]);
    if (primary.status === 'rejected') throw primary.reason;
    const aiResult = primary.value;
    const firstLines = normalizeOcrLines(aiResult.data);

    let lines: VerifiedLine[] = firstLines;
    let verification: { status: 'verified' | 'skipped'; model?: string; note?: string } = {
        status: 'skipped',
        note: 'Không chạy được lần đọc 2 — kết quả CHƯA được đối chiếu chéo, hãy rà kỹ hơn',
    };
    if (verifyResult.status === 'fulfilled') {
        lines = reconcileScans(firstLines, normalizeOcrLines(verifyResult.value.data));
        verification = { status: 'verified', model: verifyResult.value.model };
    }

    return {
        provider: aiResult.provider,
        model: aiResult.model,
        latencyMs: aiResult.latencyMs,
        verification,
        header: {
            supplierName: cleanText(aiResult.data?.header?.supplierName),
            invoiceNo: cleanText(aiResult.data?.header?.invoiceNo),
            deliveryCode: cleanText(aiResult.data?.header?.deliveryCode),
            invoiceDate: cleanText(aiResult.data?.header?.invoiceDate),
            receivedDate: cleanText(aiResult.data?.header?.receivedDate),
        },
        lines,
    };
};

export const previewPurchaseReceiptScan = async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('Don hang khong hop le');

    const files = getUploadedImages(req);
    if (!files.length) throw new BadRequestError('Chua co anh phieu nhan hang de quet');
    if (files.length > 5) throw new BadRequestError('Chi quet toi da 5 anh moi lan');

    const order = await PurchaseOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderScope(req, order);

    const scan = await scanReceiptImages(files);
    const orderItems = ((order as any).items ?? []).map((item: any, index: number) => {
        const ordered = Number(item.quantityOrdered ?? item.quantityRequested ?? 0);
        const received = Number(item.quantityReceived ?? 0);
        return {
            ...item,
            index,
            ordered,
            received,
            remaining: Math.max(0, roundQty(ordered - received)),
        };
    });

    const supplierIds = [...new Set(orderItems.map((item: any) => String(item.supplierId || '')).filter(Boolean))];
    const shortageFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        status: { $in: ['outstanding', 'partially_settled'] },
    };
    if (supplierIds.length) shortageFilter.$or = [{ supplierId: { $in: supplierIds } }, { supplierId: { $exists: false } }];

    const shortages = await PurchaseShortage.find(shortageFilter).sort('createdAt').limit(300).lean();
    const shortageState = (shortages as any[])
        .filter((shortage) => String(shortage.originalPurchaseOrderId) !== String((order as any)._id))
        .map((shortage) => ({
            ...shortage,
            quantityOutstanding: Math.max(
                0,
                roundQty(Number(shortage.quantityMissing ?? 0) - Number(shortage.quantityResolved ?? 0))
            ),
        }))
        .filter((shortage) => shortage.quantityOutstanding > 0);

    const currentRemaining = new Map<number, number>();
    orderItems.forEach((item: any) => currentRemaining.set(item.index, item.remaining));
    const shortageRemaining = new Map<string, number>();
    shortageState.forEach((shortage: any) => shortageRemaining.set(String(shortage._id), shortage.quantityOutstanding));

    const currentAllocations: Array<any> = [];
    const shortageAllocations: Array<any> = [];
    const reviewLines: Array<any> = [];
    const unreadableLines: Array<any> = [];

    // Dòng đọc dở dang (thiếu tên/SL) KHÔNG âm thầm bỏ — trả riêng để người dùng đối chiếu ảnh gốc
    const readableLines = (scan.lines as VerifiedLine[]).filter((line) => {
        const ok = line.materialName && Number(line.quantity ?? 0) > 0;
        if (!ok) {
            unreadableLines.push({
                sourceLine: line,
                reason: !line.materialName
                    ? 'AI không đọc được tên vật tư dòng này'
                    : 'AI không đọc chắc chắn được số lượng',
                note: line.verifyNote,
            });
        }
        return ok;
    });

    for (const line of readableLines) {
        let remainingQty = Number(line.quantity ?? 0);
        const lineSupplier = line.supplierName || scan.header.supplierName;
        // Dòng đủ tin cậy mới được TỰ ĐIỀN: ảnh rõ + (nếu có đối chiếu) 2 lần đọc thống nhất
        const lineConfident =
            (line.confidence ?? 0) >= AUTO_LINE_CONFIDENCE && line.verify !== 'quantity_mismatch';

        // Guard cứng: token-số phải khớp (11/75 ≠ 8/60), có ĐVT 2 bên thì phải cùng ĐVT
        const compatibleWith = (name?: string, unit?: string, supplierName?: string) =>
            !numbersConflict(line.materialName, name) &&
            (!line.unit || !unit || sameUnit(line.unit, unit)) &&
            sameSupplier(lineSupplier, supplierName);

        const candidates = orderItems
            .filter(
                (item: any) =>
                    (currentRemaining.get(item.index) ?? 0) > 0 &&
                    compatibleWith(item.materialName, item.unit, item.supplierName)
            )
            .map((item: any) => ({ item, nameSim: similarity(line.materialName, item.materialName) }))
            .filter((candidate: any) => candidate.nameSim >= 0.62)
            .sort((a: any, b: any) => b.nameSim - a.nameSim);

        for (const candidate of candidates) {
            if (remainingQty <= 0) break;
            if (!lineConfident || candidate.nameSim < AUTO_NAME_SIMILARITY) break; // dưới ngưỡng -> chỉ gợi ý
            const available = currentRemaining.get(candidate.item.index) ?? 0;
            if (available <= 0) continue;
            const quantity = roundQty(Math.min(available, remainingQty));
            if (quantity <= 0) continue;
            currentRemaining.set(candidate.item.index, roundQty(available - quantity));
            remainingQty = roundQty(remainingQty - quantity);
            currentAllocations.push({
                sourceLine: line,
                poItemIndex: candidate.item.index,
                materialName: candidate.item.materialName,
                unit: candidate.item.unit,
                quantity,
                confidence: Math.min(1, Number(((line.confidence ?? 0.65) * candidate.nameSim).toFixed(2))),
                reason: 'Khớp dòng trong đơn hiện tại',
            });
        }

        const shortageCandidates =
            remainingQty > 0
                ? shortageState
                      .filter(
                          (shortage: any) =>
                              (shortageRemaining.get(String(shortage._id)) ?? 0) > 0 &&
                              compatibleWith(shortage.materialName, shortage.unit, shortage.supplierName)
                      )
                      .map((shortage: any) => ({
                          shortage,
                          nameSim: similarity(line.materialName, shortage.materialName),
                      }))
                      .filter((candidate: any) => candidate.nameSim >= 0.62)
                      .sort((a: any, b: any) => b.nameSim - a.nameSim)
                : [];

        for (const candidate of shortageCandidates) {
            if (remainingQty <= 0) break;
            if (!lineConfident || candidate.nameSim < AUTO_NAME_SIMILARITY) break;
            const key = String(candidate.shortage._id);
            const available = shortageRemaining.get(key) ?? 0;
            if (available <= 0) continue;
            const quantity = roundQty(Math.min(available, remainingQty));
            if (quantity <= 0) continue;
            shortageRemaining.set(key, roundQty(available - quantity));
            remainingQty = roundQty(remainingQty - quantity);
            shortageAllocations.push({
                sourceLine: line,
                shortageId: key,
                originalPurchaseOrderCode: candidate.shortage.originalPurchaseOrderCode,
                materialName: candidate.shortage.materialName,
                unit: candidate.shortage.unit,
                quantity,
                confidence: Math.min(1, Number(((line.confidence ?? 0.65) * candidate.nameSim).toFixed(2))),
                reason: 'Đề xuất bù nợ hàng NCC',
            });
        }

        if (remainingQty > 0) {
            // Không tự điền — kèm GỢI Ý tốt nhất (nếu có) để người dùng tick xác nhận
            const bestItem = candidates[0];
            const bestShortage = shortageCandidates[0];
            const suggestion = bestItem
                ? {
                      type: 'po_item',
                      poItemIndex: bestItem.item.index,
                      materialName: bestItem.item.materialName,
                      unit: bestItem.item.unit,
                      quantity: roundQty(Math.min(currentRemaining.get(bestItem.item.index) ?? 0, remainingQty)),
                      nameSimilarity: Number(bestItem.nameSim.toFixed(2)),
                  }
                : bestShortage
                  ? {
                        type: 'shortage',
                        shortageId: String(bestShortage.shortage._id),
                        originalPurchaseOrderCode: bestShortage.shortage.originalPurchaseOrderCode,
                        materialName: bestShortage.shortage.materialName,
                        unit: bestShortage.shortage.unit,
                        quantity: roundQty(
                            Math.min(shortageRemaining.get(String(bestShortage.shortage._id)) ?? 0, remainingQty)
                        ),
                        nameSimilarity: Number(bestShortage.nameSim.toFixed(2)),
                    }
                  : undefined;
            reviewLines.push({
                sourceLine: line,
                quantity: remainingQty,
                reason:
                    line.verify === 'quantity_mismatch'
                        ? line.verifyNote
                        : !lineConfident
                          ? `Ảnh đọc chưa chắc chắn (tin cậy ${Math.round((line.confidence ?? 0) * 100)}%)${line.verifyNote ? ` · ${line.verifyNote}` : ''}`
                          : suggestion
                            ? 'Tên gần giống nhưng chưa đủ chắc để tự điền — xác nhận trước khi nhận'
                            : currentAllocations.some((a) => a.sourceLine === line)
                              ? 'Số lượng giao dư chưa phân bổ hết'
                              : 'Không khớp đơn hiện tại hoặc nợ cũ nào',
                suggestion: suggestion && suggestion.quantity > 0 ? suggestion : undefined,
            });
        }
    }

    const currentByIndex = new Map<number, number>();
    currentAllocations.forEach((allocation) => {
        currentByIndex.set(
            allocation.poItemIndex,
            roundQty((currentByIndex.get(allocation.poItemIndex) ?? 0) + allocation.quantity)
        );
    });
    const shortageById = new Map<string, number>();
    shortageAllocations.forEach((allocation) => {
        shortageById.set(allocation.shortageId, roundQty((shortageById.get(allocation.shortageId) ?? 0) + allocation.quantity));
    });

    const shortageMarks = orderItems
        .filter((item: any) => {
            const receivedNow = currentByIndex.get(item.index) ?? 0;
            return receivedNow > 0 && receivedNow < item.remaining;
        })
        .map((item: any) => ({
            index: item.index,
            materialName: item.materialName,
            remainingAfterReceipt: roundQty(item.remaining - (currentByIndex.get(item.index) ?? 0)),
            reason: 'Phiếu giao có nhận một phần, còn thiếu so với số lượng đang chờ',
        }));

    const proposedPayload = {
        items: [...currentByIndex.entries()].map(([index, quantityReceived]) => ({
            index,
            quantityReceived,
            markShortage: shortageMarks.some((mark: { index: number }) => mark.index === index),
        })),
        shortageAllocations: [...shortageById.entries()].map(([shortageId, quantityReceived]) => ({
            shortageId,
            quantityReceived,
            note: `AI đề xuất bù từ phiếu ${scan.header.deliveryCode || scan.header.invoiceNo || 'nhận hàng'}`,
        })),
    };

    const summary = {
        extractedLineCount: scan.lines.length,
        currentOrderQuantity: roundQty(currentAllocations.reduce((sum, row) => sum + row.quantity, 0)),
        shortageResolvedQuantity: roundQty(shortageAllocations.reduce((sum, row) => sum + row.quantity, 0)),
        reviewQuantity: roundQty(reviewLines.reduce((sum, row) => sum + row.quantity, 0)),
        reviewLineCount: reviewLines.length,
        unreadableLineCount: unreadableLines.length,
        shortageMarkCount: shortageMarks.length,
        verifiedLineCount: (scan.lines as VerifiedLine[]).filter((line) => line.verify === 'agreed').length,
        verification: scan.verification,
    };

    const scanRecord = await PurchaseReceiptScan.create({
        purchaseOrderId: (order as any)._id,
        purchaseOrderCode: (order as any).orderCode,
        status: 'preview',
        fileCount: files.length,
        header: scan.header,
        extractedLines: scan.lines,
        currentAllocations,
        shortageAllocations,
        reviewLines,
        shortageMarks,
        proposedPayload,
        summary,
        provider: scan.provider,
        model: scan.model,
        latencyMs: scan.latencyMs,
        createdBy: req.userId,
    });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                scanId: String((scanRecord as any)._id),
                available: true,
                provider: scan.provider,
                model: scan.model,
                latencyMs: scan.latencyMs,
                verification: scan.verification,
                header: scan.header,
                extractedLines: scan.lines,
                currentAllocations,
                shortageAllocations,
                reviewLines,
                unreadableLines,
                shortageMarks,
                openShortages: shortageState.map(serializePurchaseShortage),
                proposedPayload,
                summary,
            },
            message: 'Da quet va doi soat phieu nhan hang',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPurchaseReceiptScans = async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('Don hang khong hop le');

    const order = await PurchaseOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderScope(req, order);

    const scans = await PurchaseReceiptScan.find({ purchaseOrderId: req.params.id })
        .sort('-createdAt')
        .limit(Number(req.query.limit ?? 20))
        .lean();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: scans.map((scan: any) => ({
                id: String(scan._id),
                purchaseOrderId: String(scan.purchaseOrderId),
                purchaseOrderCode: scan.purchaseOrderCode,
                status: scan.status,
                fileCount: scan.fileCount ?? 0,
                header: scan.header ?? {},
                summary: scan.summary ?? {},
                provider: scan.provider,
                model: scan.model,
                latencyMs: scan.latencyMs,
                createdBy: toId(scan.createdBy),
                appliedBy: toId(scan.appliedBy),
                appliedAt: scan.appliedAt ? new Date(scan.appliedAt).toISOString() : undefined,
                createdAt: scan.createdAt ? new Date(scan.createdAt).toISOString() : undefined,
                updatedAt: scan.updatedAt ? new Date(scan.updatedAt).toISOString() : undefined,
            })),
            message: 'Lay lich su quet phieu nhan hang thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
