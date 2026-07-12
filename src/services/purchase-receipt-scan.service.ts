import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { AI_FEATURES } from '@/constant/aiModels';
import config from '@/config/env.config';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import PurchaseOrder from '@/models/PurchaseOrder';
import PurchaseReceiptScan from '@/models/PurchaseReceiptScan';
import PurchaseShortage from '@/models/PurchaseShortage';
import SupplierItemAlias from '@/models/SupplierItemAlias';
import { aiProviderService, type AiGenerateTextOptions } from '@/services/ai/ai-provider.service';
import { vertexProviderService } from '@/services/ai/vertex-provider.service';
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

/**
 * Điểm khớp tên vật tư: lấy MAX(jaccard, độ-chứa-trọn). Tên phiếu NCC thường dài hơn
 * tên danh mục ("Mặt nguyệt vắt sổ 277505/277517/277516 hiệu LDM" vs "Mặt nguyệt vắt sổ 277505")
 * — bên ngắn nằm TRỌN trong bên dài thì coi là khớp 100%. An toàn vì numbersConflict
 * vẫn chặn biến thể (DBx1 ≠ DCx1, 9/65 ≠ 11/75). Bên ngắn chỉ 1 token thì không dùng
 * độ-chứa (tránh "Kim" khớp mọi loại kim).
 */
const nameMatchScore = (a: unknown, b: unknown) => {
    const ta = tokenSet(a);
    const tb = tokenSet(b);
    if (!ta.size || !tb.size) return 0;
    let intersection = 0;
    ta.forEach((token) => {
        if (tb.has(token)) intersection += 1;
    });
    const jaccard = intersection / Math.max(ta.size, tb.size);
    const smaller = Math.min(ta.size, tb.size);
    const containment = smaller >= 2 ? intersection / smaller : 0;
    return Math.max(jaccard, containment);
};

/** ĐVT đồng nghĩa hay gặp: phiếu NCC ghi "Chiếc" nhưng danh mục lưu "cái"… — quy về 1 dạng chuẩn. */
const UNIT_SYNONYMS: Record<string, string> = {
    cai: 'cai',
    chiec: 'cai',
    pc: 'cai',
    pcs: 'cai',
    con: 'cai',
    bo: 'bo',
    set: 'bo',
    doi: 'doi',
    cap: 'doi',
    pair: 'doi',
    cuon: 'cuon',
    roll: 'cuon',
    m: 'm',
    met: 'm',
    md: 'm',
    kg: 'kg',
    ky: 'kg',
    ki: 'kg',
    hop: 'hop',
    box: 'hop',
    tui: 'tui',
    goi: 'tui',
    chai: 'chai',
    lo: 'chai',
    thung: 'thung',
    cay: 'cay',
    thanh: 'cay',
};

const canonicalUnit = (value: unknown) => {
    const normalized = normalizeText(value).replace(/\s+/g, '');
    return UNIT_SYNONYMS[normalized] || normalized;
};

const sameUnit = (a?: string, b?: string) => {
    if (!a || !b) return true;
    return canonicalUnit(a) === canonicalUnit(b) || similarity(a, b) >= 0.78;
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

/**
 * Ngưỡng tự điền: dưới ngưỡng này AI chỉ được GỢI Ý, người dùng phải tự xác nhận.
 * Ảnh đọc rất rõ (>=0.9, đã đối chiếu 2 lần) thì tên khớp >=0.85 là đủ tự điền —
 * guard token-số + ĐVT vẫn chặn nhầm biến thể (9/65 ≠ 11/75).
 */
const AUTO_LINE_CONFIDENCE = 0.75;
const AUTO_NAME_SIMILARITY = 0.9;
const AUTO_NAME_SIMILARITY_CLEAR = 0.85;
const CLEAR_LINE_CONFIDENCE = 0.9;

const autoEligible = (lineConfidence: number, nameSim: number, unitOk: boolean) => {
    if (!unitOk) return false;
    if (lineConfidence >= CLEAR_LINE_CONFIDENCE && nameSim >= AUTO_NAME_SIMILARITY_CLEAR) return true;
    return lineConfidence >= AUTO_LINE_CONFIDENCE && nameSim >= AUTO_NAME_SIMILARITY;
};

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
        'TIENG VIET PHAI DU DAU: moi text tra ve (ten hang, ten cong ty, ghi chu) viet tieng Viet CO DAU day du. Neu chu tren anh mo/mat dau, KHOI PHUC dau theo tu vung nganh may thong dung (vd "ong nhua"->"ống nhựa", "mo duoi vat so"->"mỏ dưới vắt sổ", "day cap"->"dây cấp", "mat nguyet"->"mặt nguyệt", "cam bien"->"cảm biến"). CON SO thi nguoc lai: mo/khong ro -> null, KHONG doan.',
        'Neu bang co cot "Ma hang"/"Ma so"/"Ma vat tu" thi ghi vao note dang "Mã hàng: <ma>" (giu nguyen ky tu ma).',
        'header.supplierName = TEN CONG TY PHAT HANH phieu o dau trang (letterhead/dong dau). Dong "Don vi:"/"Kinh gui:" la BEN MUA (cong ty minh) — TUYET DOI KHONG dien vao supplierName.',
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
            const sim = nameMatchScore(line.materialName, cand.materialName);
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

const generateReceiptOcrJson = async <T>(
    options: AiGenerateTextOptions,
    vertexModel: string
) => {
    if (vertexProviderService.isEnabled()) {
        try {
            return await vertexProviderService.generateJson<T>({
                ...options,
                model: vertexModel,
                timeoutMs: Math.max(options.timeoutMs ?? 0, config.vertex.timeoutMs),
            });
        } catch (error) {
            console.warn(
                `[vertex-ocr] receipt ${options.feature || ''} failed, fallback to 9router:`,
                error instanceof Error ? error.message : error
            );
        }
    }
    return aiProviderService.generateJson<T>(options);
};

const runOcrPass = async (files: Express.Multer.File[], feature: string) => {
    const content = [
        { type: 'text' as const, text: buildReceiptOcrPrompt() },
        ...files.map((file) => ({
            type: 'image_url' as const,
            image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` },
        })),
    ];

    const vertexModel =
        feature === AI_FEATURES.OCR_PURCHASE_RECEIPT_VERIFY ? config.vertex.verifyModel : config.vertex.visionModel;

    return generateReceiptOcrJson<ReceiptOcrResult>(
        {
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
        },
        vertexModel
    );
};

/**
 * Đọc 2 LẦN ĐỘC LẬP bằng 2 model khác dòng (gemini + gpt) rồi đối chiếu.
 * Mỗi ẢNH được OCR RIÊNG (chất lượng đọc per-image cao hơn hẳn dồn nhiều ảnh
 * một request — đã kiểm chứng cùng model trên phiếu thật) và đối chiếu THEO TRANG
 * để dòng trang này không bị so nhầm với trang khác.
 * Lần 2 lỗi (model bận/hết quota) thì vẫn chạy tiếp 1 lần đọc, nhưng đánh dấu chưa đối chiếu.
 */
const scanReceiptImages = async (files: Express.Multer.File[]) => {
    const startedAt = Date.now();
    const [primaryPages, verifyPages] = await Promise.all([
        Promise.allSettled(files.map((file) => runOcrPass([file], AI_FEATURES.OCR_PURCHASE_RECEIPT))),
        Promise.allSettled(files.map((file) => runOcrPass([file], AI_FEATURES.OCR_PURCHASE_RECEIPT_VERIFY))),
    ]);

    const firstFailure = primaryPages.find((page) => page.status === 'rejected');
    if (primaryPages.every((page) => page.status === 'rejected')) {
        throw (firstFailure as PromiseRejectedResult).reason;
    }

    const withPageIndex = (lines: ReceiptOcrLine[], pageIndex: number) =>
        lines.map((line) => ({ ...line, pageIndex }));

    const lines: VerifiedLine[] = [];
    let verifiedAllPages = true;
    let verifyModel: string | undefined;
    let sampleResult: any;
    let header: ReceiptOcrResult['header'] | undefined;

    files.forEach((_, pageIndex) => {
        const primary = primaryPages[pageIndex];
        if (primary.status === 'rejected') {
            verifiedAllPages = false;
            return;
        }
        sampleResult = sampleResult ?? primary.value;
        if (!header?.supplierName && primary.value.data?.header) header = primary.value.data.header;

        const firstLines = withPageIndex(normalizeOcrLines(primary.value.data), pageIndex);
        const verify = verifyPages[pageIndex];
        if (verify.status === 'fulfilled') {
            verifyModel = verify.value.model;
            lines.push(...reconcileScans(firstLines, withPageIndex(normalizeOcrLines(verify.value.data), pageIndex)));
        } else {
            verifiedAllPages = false;
            lines.push(...firstLines);
        }
    });

    const verification: { status: 'verified' | 'skipped'; model?: string; note?: string } = verifiedAllPages
        ? { status: 'verified', model: verifyModel }
        : {
              status: 'skipped',
              note: 'Không chạy được lần đọc 2 cho toàn bộ ảnh — kết quả CHƯA được đối chiếu chéo đầy đủ, hãy rà kỹ hơn',
          };

    return {
        provider: sampleResult?.provider,
        model: sampleResult?.model,
        latencyMs: Date.now() - startedAt,
        verification,
        header: {
            supplierName: cleanText(header?.supplierName),
            invoiceNo: cleanText(header?.invoiceNo),
            deliveryCode: cleanText(header?.deliveryCode),
            invoiceDate: cleanText(header?.invoiceDate),
            receivedDate: cleanText(header?.receivedDate),
        },
        lines,
    };
};

// ── Bộ nhớ NCC: tra alias đã học từ các lần đối soát tay trước ─────────────────
const extractAliasCode = (line: ReceiptOcrLine) => {
    const match = `${line.note ?? ''} ${line.rawText ?? ''}`.match(
        /m[aã]\s*(?:h[aà]ng|s[oố]|v[aậ]t\s*t[uư])?\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{2,})/i
    );
    return match?.[1]?.toUpperCase();
};

const loadSupplierAliases = async (supplierName?: string) => {
    const supplierKey = normalizeText(supplierName);
    if (!supplierKey) return { byCode: new Map<string, any>(), byName: new Map<string, any>() };
    const aliases = await SupplierItemAlias.find({ supplierKey }).sort('-useCount').limit(500).lean();
    const byCode = new Map<string, any>();
    const byName = new Map<string, any>();
    (aliases as any[]).forEach((alias) => {
        if (alias.aliasCode && !byCode.has(alias.aliasCode)) byCode.set(alias.aliasCode, alias);
        if (alias.aliasKey && !byName.has(alias.aliasKey)) byName.set(alias.aliasKey, alias);
    });
    return { byCode, byName };
};

// ── AI ghép NGỮ NGHĨA: cứu các dòng tên NCC ≠ tên nội bộ mà so chuỗi bó tay ────
type SemanticMatch = {
    reviewIndex: number;
    type: 'po_item' | 'shortage' | 'none';
    poItemIndex?: number | null;
    shortageId?: string | null;
    confidence?: number;
    reason?: string;
};

const buildSemanticMatchPrompt = () =>
    [
        'Ban la chuyen gia vat tu nganh may cong nghiep. Nhiem vu: ghep tung DONG PHIEU GIAO cua nha cung cap vao dung DONG DON DAT (hoac NO HANG cu) neu chung la CUNG MOT MAT HANG THUC TE.',
        'Ten hai ben thuong ghi KHAC nhau: NCC ghi ten ky thuat/quy cach, don noi bo ghi ten dan da. Vi du cung mot mon: "Ong nhua PU kt:6x4mm x 200M" = "Day hoi may nen khi phi 6mm"; "Mo duoi vat so PEGASUS" = "Moc duoi (mo duoi) vat so Pegasus"; "Cam bien Y, ma hang 0103040478" = "Cam bien tiem can dinh vi truc Y"; "Mat nguyet may 1 kim dien tu F20" = "Mat nguyet dung cho may may cong nghiep 1 kim".',
        'Tin hieu manh de ghep: SO LUONG giao khop so luong dang cho nhan; kich co/ma so/thuong hieu trung nhau; cung nhom chuc nang.',
        'CAN TRONG voi bien the: kich thuoc khac nhau (phi 6 vs phi 8, 11/75 vs 9/65, 4 chi vs 5 chi) la 2 mat hang KHAC nhau — KHONG ghep.',
        'Moi dong phieu ghep TOI DA 1 dong don/no; moi dong don chi duoc nhan toi da 1 dong phieu.',
        'confidence: >=0.9 chi khi rat chac cung mat hang; 0.7-0.85 kha nang cao; <0.7 -> type "none".',
        'reason viet tieng Viet ngan gon (vi sao ghep / vi sao khong).',
        'Chi tra JSON hop le: {"matches":[{"reviewIndex":0,"type":"po_item","poItemIndex":3,"shortageId":null,"confidence":0.9,"reason":""}]}',
    ].join('\n');

const runSemanticMatch = async (
    pendingLines: Array<{ line: VerifiedLine; quantity: number }>,
    orderItems: any[],
    shortages: any[],
    remainingByIndex: Map<number, number>,
    shortageRemaining: Map<string, number>
): Promise<SemanticMatch[]> => {
    const openItems = orderItems.filter((item: any) => (remainingByIndex.get(item.index) ?? 0) > 0);
    if (!pendingLines.length || (!openItems.length && !shortages.length)) return [];

    const lineRows = pendingLines.map(
        ({ line, quantity }, index) =>
            `R${index}: "${line.materialName}" | SL giao=${quantity} ${line.unit || ''}${line.note ? ` | ${line.note}` : ''}`
    );
    const itemRows = openItems.map(
        (item: any) =>
            `P${item.index}: "${item.materialName}" | DVT=${item.unit || '?'} | con cho nhan=${remainingByIndex.get(item.index) ?? 0}${item.supplierName ? ` | NCC=${item.supplierName}` : ''}`
    );
    const shortageRows = shortages
        .filter((shortage: any) => (shortageRemaining.get(String(shortage._id)) ?? 0) > 0)
        .map(
            (shortage: any) =>
                `S${shortage._id}: "${shortage.materialName}" | DVT=${shortage.unit || '?'} | con no=${shortageRemaining.get(String(shortage._id)) ?? 0} | tu don ${shortage.originalPurchaseOrderCode || ''}`
        );

    try {
        const result = await generateReceiptOcrJson<{ matches?: SemanticMatch[] }>(
            {
                feature: AI_FEATURES.RECEIPT_SEMANTIC_MATCH,
                temperature: 0.05,
                reasoningEffort: 'low',
                maxTokens: 4000,
                timeoutMs: 45000,
                messages: [
                    { role: 'system', content: buildSemanticMatchPrompt() },
                    {
                        role: 'user',
                        content: [
                            'DONG PHIEU GIAO CHUA GHEP DUOC:',
                            ...lineRows,
                            '',
                            'DONG DON DAT CON CHO NHAN:',
                            ...itemRows,
                            ...(shortageRows.length ? ['', 'NO HANG CU CON THIEU:', ...shortageRows] : []),
                        ].join('\n'),
                    },
                ],
            },
            config.vertex.visionModel
        );
        return Array.isArray(result.data?.matches) ? result.data.matches : [];
    } catch (error) {
        console.warn('[receipt-scan] semantic match failed, skip:', error instanceof Error ? error.message : error);
        return [];
    }
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

    // Bộ nhớ map NCC học từ các lần đối soát tay trước
    const aliases = await loadSupplierAliases(scan.header.supplierName);

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
        const lineConfidence = line.confidence ?? 0;
        const lineSupplier = line.supplierName || scan.header.supplierName;
        // Dòng đủ tin cậy mới được TỰ ĐIỀN: ảnh rõ + (nếu có đối chiếu) 2 lần đọc thống nhất
        const lineConfident = lineConfidence >= AUTO_LINE_CONFIDENCE && line.verify !== 'quantity_mismatch';

        // Guard cứng: token-số phải khớp (11/75 ≠ 8/60). Lệch ĐVT KHÔNG loại ứng viên
        // (phiếu "Chiếc" vs danh mục "cái" là chuyện thường) — chỉ chặn TỰ ĐIỀN, vẫn gợi ý.
        const compatibleWith = (name?: string, supplierName?: string) =>
            !numbersConflict(line.materialName, name) && sameSupplier(lineSupplier, supplierName);

        // Bộ nhớ NCC: tên/mã hàng này đã được map tay trước đây -> khớp ngay không cần so chuỗi
        const lineAliasCode = extractAliasCode(line);
        const aliasHit =
            (lineAliasCode ? aliases.byCode.get(lineAliasCode) : undefined) ||
            aliases.byName.get(normalizeText(line.materialName));
        let aliasSuggestionItem: any;
        if (aliasHit && remainingQty > 0) {
            const aliasBest = orderItems
                .filter((item: any) => (currentRemaining.get(item.index) ?? 0) > 0)
                .map((item: any) => ({ item, sim: nameMatchScore(aliasHit.targetMaterialName, item.materialName) }))
                .sort((a: any, b: any) => b.sim - a.sim)[0];
            if (aliasBest && aliasBest.sim >= 0.8) {
                if (lineConfident) {
                    const available = currentRemaining.get(aliasBest.item.index) ?? 0;
                    const quantity = roundQty(Math.min(available, remainingQty));
                    if (quantity > 0) {
                        currentRemaining.set(aliasBest.item.index, roundQty(available - quantity));
                        remainingQty = roundQty(remainingQty - quantity);
                        currentAllocations.push({
                            sourceLine: line,
                            poItemIndex: aliasBest.item.index,
                            materialName: aliasBest.item.materialName,
                            unit: aliasBest.item.unit,
                            quantity,
                            confidence: 0.95,
                            reason: `Khớp lịch sử NCC (đã map ${aliasHit.useCount ?? 1} lần trước)`,
                        });
                    }
                } else {
                    aliasSuggestionItem = aliasBest.item;
                }
            }
        }

        const candidates = orderItems
            .filter(
                (item: any) =>
                    (currentRemaining.get(item.index) ?? 0) > 0 &&
                    compatibleWith(item.materialName, item.supplierName)
            )
            .map((item: any) => ({
                item,
                nameSim: nameMatchScore(line.materialName, item.materialName),
                unitOk: sameUnit(line.unit, item.unit),
            }))
            .filter((candidate: any) => candidate.nameSim >= 0.62)
            .sort((a: any, b: any) => b.nameSim + (b.unitOk ? 0.05 : 0) - (a.nameSim + (a.unitOk ? 0.05 : 0)));

        for (const candidate of candidates) {
            if (remainingQty <= 0) break;
            if (!lineConfident || !autoEligible(lineConfidence, candidate.nameSim, candidate.unitOk)) break; // dưới ngưỡng -> chỉ gợi ý
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
                confidence: Math.min(1, Number((lineConfidence * candidate.nameSim).toFixed(2))),
                reason: 'Khớp dòng trong đơn hiện tại',
            });
        }

        const shortageCandidates =
            remainingQty > 0
                ? shortageState
                      .filter(
                          (shortage: any) =>
                              (shortageRemaining.get(String(shortage._id)) ?? 0) > 0 &&
                              compatibleWith(shortage.materialName, shortage.supplierName)
                      )
                      .map((shortage: any) => ({
                          shortage,
                          nameSim: nameMatchScore(line.materialName, shortage.materialName),
                          unitOk: sameUnit(line.unit, shortage.unit),
                      }))
                      .filter((candidate: any) => candidate.nameSim >= 0.62)
                      .sort(
                          (a: any, b: any) =>
                              b.nameSim + (b.unitOk ? 0.05 : 0) - (a.nameSim + (a.unitOk ? 0.05 : 0))
                      )
                : [];

        for (const candidate of shortageCandidates) {
            if (remainingQty <= 0) break;
            if (!lineConfident || !autoEligible(lineConfidence, candidate.nameSim, candidate.unitOk)) break;
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
                confidence: Math.min(1, Number((lineConfidence * candidate.nameSim).toFixed(2))),
                reason: 'Đề xuất bù nợ hàng NCC',
            });
        }

        if (remainingQty > 0) {
            // Không tự điền — kèm GỢI Ý tốt nhất (nếu có) để người dùng tick xác nhận
            // Alias lịch sử NCC là gợi ý mạnh nhất (đã từng map tay đúng món này)
            const bestItem = aliasSuggestionItem
                ? { item: aliasSuggestionItem, nameSim: 0.95, unitOk: sameUnit(line.unit, aliasSuggestionItem.unit) }
                : candidates[0];
            const bestShortage = shortageCandidates[0];
            let suggestion: any = bestItem
                ? {
                      type: 'po_item',
                      poItemIndex: bestItem.item.index,
                      materialName: bestItem.item.materialName,
                      unit: bestItem.item.unit,
                      unitMismatch: !bestItem.unitOk ? line.unit || '' : undefined,
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
                        unitMismatch: !bestShortage.unitOk ? line.unit || '' : undefined,
                        quantity: roundQty(
                            Math.min(shortageRemaining.get(String(bestShortage.shortage._id)) ?? 0, remainingQty)
                        ),
                        nameSimilarity: Number(bestShortage.nameSim.toFixed(2)),
                    }
                  : undefined;
            if (suggestion && suggestion.quantity <= 0) suggestion = undefined;
            const hadAuto = currentAllocations.some((a) => a.sourceLine === line);
            reviewLines.push({
                sourceLine: line,
                quantity: remainingQty,
                reason:
                    line.verify === 'quantity_mismatch'
                        ? line.verifyNote
                        : !lineConfident
                          ? `Ảnh đọc chưa chắc chắn (tin cậy ${Math.round(lineConfidence * 100)}%)${line.verifyNote ? ` · ${line.verifyNote}` : ''}`
                          : suggestion?.unitMismatch
                            ? `Lệch đơn vị tính: phiếu ghi "${line.unit || '?'}", hệ thống lưu "${suggestion.unit || '?'}" — xác nhận trước khi nhận`
                            : suggestion
                              ? 'Tên gần giống nhưng chưa đủ chắc để tự điền — xác nhận trước khi nhận'
                              : hadAuto
                                ? 'Số lượng giao dư so với phần còn chờ của đơn'
                                : 'Không khớp đơn hiện tại hoặc nợ cũ nào',
                suggestion,
            });
        }
    }

    // ── AI ghép ngữ nghĩa: cứu các dòng ảnh đọc rõ nhưng so chuỗi không ra
    // (tên NCC khác hẳn tên nội bộ: "Ống nhựa PU 6x4mm" vs "Dây hơi phi 6mm")
    const pendingForAi = reviewLines
        .map((row: any, index: number) => ({ row, index }))
        .filter(
            ({ row }) =>
                row.quantity > 0 &&
                (row.sourceLine?.confidence ?? 0) >= AUTO_LINE_CONFIDENCE &&
                row.sourceLine?.verify !== 'quantity_mismatch'
        );
    if (pendingForAi.length) {
        const matches = await runSemanticMatch(
            pendingForAi.map(({ row }) => ({ line: row.sourceLine, quantity: row.quantity })),
            orderItems,
            shortageState,
            currentRemaining,
            shortageRemaining
        );
        const usedPo = new Set<number>();
        const usedShortage = new Set<string>();
        const resolvedReviewIdx = new Set<number>();

        for (const match of matches) {
            const pending = pendingForAi[Number(match.reviewIndex)];
            if (!pending || match.type === 'none') continue;
            const row: any = pending.row;
            const confidence = Math.min(1, Math.max(0, Number(match.confidence ?? 0)));

            if (match.type === 'po_item' && match.poItemIndex != null && !usedPo.has(Number(match.poItemIndex))) {
                const itemIndex = Number(match.poItemIndex);
                const item = orderItems.find((candidate: any) => candidate.index === itemIndex);
                const available = currentRemaining.get(itemIndex) ?? 0;
                if (!item || available <= 0) continue;
                const unitOk = sameUnit(row.sourceLine.unit, item.unit);
                const quantity = roundQty(Math.min(available, row.quantity));
                if (confidence >= 0.85 && unitOk && quantity > 0 && row.quantity <= available) {
                    usedPo.add(itemIndex);
                    currentRemaining.set(itemIndex, roundQty(available - quantity));
                    currentAllocations.push({
                        sourceLine: row.sourceLine,
                        poItemIndex: itemIndex,
                        materialName: item.materialName,
                        unit: item.unit,
                        quantity,
                        confidence: Number(confidence.toFixed(2)),
                        reason: `AI đối chiếu ngữ nghĩa: ${match.reason || 'cùng một mặt hàng'}`,
                    });
                    resolvedReviewIdx.add(pending.index);
                } else if (confidence >= 0.6 && quantity > 0 && !row.suggestion) {
                    row.suggestion = {
                        type: 'po_item',
                        poItemIndex: itemIndex,
                        materialName: item.materialName,
                        unit: item.unit,
                        unitMismatch: !unitOk ? row.sourceLine.unit || '' : undefined,
                        quantity,
                        nameSimilarity: Number(confidence.toFixed(2)),
                    };
                    row.reason = `AI cho rằng đây là "${item.materialName}" (tin cậy ${Math.round(confidence * 100)}%)${match.reason ? `: ${match.reason}` : ''} — xác nhận trước khi nhận`;
                }
            } else if (match.type === 'shortage' && match.shortageId && !usedShortage.has(String(match.shortageId))) {
                const key = String(match.shortageId);
                const shortage = shortageState.find((candidate: any) => String(candidate._id) === key);
                const available = shortageRemaining.get(key) ?? 0;
                if (!shortage || available <= 0) continue;
                const unitOk = sameUnit(row.sourceLine.unit, (shortage as any).unit);
                const quantity = roundQty(Math.min(available, row.quantity));
                if (confidence >= 0.85 && unitOk && quantity > 0 && row.quantity <= available) {
                    usedShortage.add(key);
                    shortageRemaining.set(key, roundQty(available - quantity));
                    shortageAllocations.push({
                        sourceLine: row.sourceLine,
                        shortageId: key,
                        originalPurchaseOrderCode: (shortage as any).originalPurchaseOrderCode,
                        materialName: (shortage as any).materialName,
                        unit: (shortage as any).unit,
                        quantity,
                        confidence: Number(confidence.toFixed(2)),
                        reason: `AI đối chiếu ngữ nghĩa: ${match.reason || 'bù nợ hàng cũ'}`,
                    });
                    resolvedReviewIdx.add(pending.index);
                } else if (confidence >= 0.6 && quantity > 0 && !row.suggestion) {
                    row.suggestion = {
                        type: 'shortage',
                        shortageId: key,
                        originalPurchaseOrderCode: (shortage as any).originalPurchaseOrderCode,
                        materialName: (shortage as any).materialName,
                        unit: (shortage as any).unit,
                        unitMismatch: !unitOk ? row.sourceLine.unit || '' : undefined,
                        quantity,
                        nameSimilarity: Number(confidence.toFixed(2)),
                    };
                    row.reason = `AI cho rằng đây là nợ cũ "${(shortage as any).materialName}" (tin cậy ${Math.round(confidence * 100)}%) — xác nhận trước khi nhận`;
                }
            }
        }
        for (let index = reviewLines.length - 1; index >= 0; index -= 1) {
            if (resolvedReviewIdx.has(index)) reviewLines.splice(index, 1);
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

/**
 * Học map NCC từ lần đối soát tay: FE gọi khi người dùng bấm "Áp dụng vào form".
 * Lần giao sau cùng NCC, cùng tên/mã hàng sẽ được tự map ngay (không cần AI).
 */
export const recordReceiptScanMappings = async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequestError('Don hang khong hop le');
    const order = await PurchaseOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).lean();
    if (!order) throw new NotFoundError('Khong tim thay don dat hang');
    ensureOrderScope(req, order);

    const mappings: Array<{ materialName?: string; note?: string; supplierName?: string; poItemIndex?: number }> =
        Array.isArray(req.body?.mappings) ? req.body.mappings : [];
    const supplierFallback = cleanText(req.body?.supplierName);
    let saved = 0;

    for (const mapping of mappings.slice(0, 100)) {
        const item = ((order as any).items ?? [])[Number(mapping.poItemIndex ?? -1)];
        const supplierName = cleanText(mapping.supplierName) || supplierFallback || item?.supplierName;
        const supplierKey = normalizeText(supplierName);
        const aliasKey = normalizeText(mapping.materialName);
        if (!supplierKey || !aliasKey || !item?.materialName) continue;
        // Tên 2 bên vốn trùng nhau thì string-match tự lo, không cần tốn alias
        if (aliasKey === normalizeText(item.materialName)) continue;

        const aliasCode = extractAliasCode({ materialName: mapping.materialName ?? '', note: mapping.note } as any);
        await SupplierItemAlias.updateOne(
            { supplierKey, aliasKey },
            {
                $set: {
                    supplierName,
                    aliasText: mapping.materialName,
                    aliasCode,
                    targetMaterialName: item.materialName,
                    targetMaterialId: item.materialId || undefined,
                    targetUnit: item.unit,
                    lastUsedAt: new Date(),
                    updatedBy: req.userId,
                },
                $setOnInsert: { createdBy: req.userId },
                $inc: { useCount: 1 },
            },
            { upsert: true }
        );
        saved += 1;
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { saved },
            message: 'Da luu map ten hang NCC',
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
