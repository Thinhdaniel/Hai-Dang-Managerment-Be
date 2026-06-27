import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError } from '@/errors/customError';
import { AI_FEATURES } from '@/constant/aiModels';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import customResponse from '@/utils/response';

// OCR ảnh hóa đơn/phiếu mua vật tư -> trích dòng có cấu trúc để điền sẵn đơn mua.
// Dùng model VISION (gc/gemini-2.5-flash) qua 9router. Ảnh nằm trong RAM (multer memory),
// chuyển base64 gửi thẳng cho model — KHÔNG lưu trữ ảnh.
//
// Mẫu phiếu thật của công ty ("DANH SÁCH MUA VẬT TƯ") giàu cột: Cơ sở, Người đề xuất,
// Số lượng cần vs Số lượng mua, Đơn giá, VAT, Nhà cung cấp, Nội dung, Ghi chú, Ngày...
// -> trích đủ để khớp 1-1 với các trường của form đơn mua.
//
// QUAN TRỌNG: KHÔNG dùng zod strict — output dài (nhiều cột x nhiều dòng) hay khiến model
// trả số dạng chuỗi/thiếu trường, strict parse sẽ throw -> rơi fallback oan. Ở đây đọc KHOAN
// DUNG (ép kiểu mềm, bỏ trường lỗi) + thử lại nhiều lần (model chính x2 + model vision dự phòng) cho ổn định.

// Model vision ỔN ĐỊNH cho OCR. BẮT BUỘC dùng model KHÔNG-"thinking" (gemini-2.5-flash):
// model thinking (vd gemini-2.5-pro) đốt token budget vào suy luận nội bộ -> chỉ còn vài chục
// token cho JSON -> output bị CẮT CỤT với phiếu nhiều dòng -> parse lỗi -> rơi fallback rỗng.
const OCR_RELIABLE_VISION_MODEL = 'gc/gemini-2.5-flash';

// CHỈ honor AI_OCR_MODEL riêng cho OCR (KHÔNG kế thừa AI_VISION_MODEL chung — env đó có thể là
// model thinking khiến OCR cắt cụt). Không set thì mặc định model ổn định ở trên.
const OCR_PRIMARY_VISION_MODEL = process.env.AI_OCR_MODEL || OCR_RELIABLE_VISION_MODEL;

// Model cho lần thử cuối (cấu hình qua env). Mặc định vẫn flash (non-thinking) cho an toàn.
const OCR_FALLBACK_VISION_MODEL = process.env.AI_OCR_FALLBACK_MODEL || OCR_RELIABLE_VISION_MODEL;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chạy 1 lượt OCR (attempt) nhiều lần cho ỔN ĐỊNH:
 *   - lần 1: model chính (theo env hoặc flash).
 *   - lần 2: LUÔN là model ổn định non-thinking (flash) làm lưới an toàn, nghỉ ngắn để né rate-limit dồn.
 *   - lần 3: model dự phòng theo env.
 * `attempt` nhận model (có thể undefined -> để aiProvider tự resolve theo feature).
 */
const runOcrWithRetry = async <T>(
    attempt: (model?: string) => Promise<T>,
    primaryModel?: string
): Promise<T> => {
    const plan: (string | undefined)[] = [
        primaryModel ?? OCR_RELIABLE_VISION_MODEL,
        OCR_RELIABLE_VISION_MODEL,
        OCR_FALLBACK_VISION_MODEL,
    ];
    let lastError: unknown;
    for (let i = 0; i < plan.length; i++) {
        try {
            return await attempt(plan[i]);
        } catch (error) {
            lastError = error;
            if (i < plan.length - 1) await sleep(400 * (i + 1)); // backoff nhẹ: 400ms, 800ms
        }
    }
    throw lastError;
};

type OcrItem = {
    materialName: string;
    unit?: string;
    quantityRequested?: number;
    quantity?: number;
    unitPrice?: number;
    vatRate?: number;
    plantName?: string;
    proposedBy?: string;
    supplierName?: string;
    purpose?: string;
    note?: string;
    orderDate?: string;
    receivedDate?: string;
};

type SupplyOcrItem = {
    materialName: string;
    unit?: string;
    quantityRequested?: number;
    purpose?: string;
    note?: string;
};

const cleanNumber = (value: unknown): number | undefined => {
    if (value == null || value === '') return undefined;
    // Chấp nhận số hoặc chuỗi số (bỏ ký tự không phải số, giữ dấu chấm thập phân khi rõ ràng).
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const cleanText = (value: unknown): string | undefined => {
    const text = String(value ?? '').trim();
    return text && text.toLowerCase() !== 'null' ? text : undefined;
};

const buildPrompt = () =>
    [
        'Ban la tro ly OCR phieu/hoa don mua vat tu cua cong ty may (tieng Viet).',
        'Doc anh dinh kem (thuong la BANG "DANH SACH MUA VAT TU") va trich CHINH XAC tung dong + thong tin chung.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'TUYET DOI khong bia: truong nao khong doc duoc thi de null.',
        'So tien/so luong tra ve SO thuan, KHONG dau phan cach nghin (vd "1.200.000" -> 1200000, "12,5" -> 12.5). Don gia theo VND.',
        'PHAN BIET 2 cot so luong neu co: "So luong can" -> quantityRequested; "So luong" (cot gan don gia, khop thanh tien) -> quantity.',
        'vatRate la phan tram thue (vd 8, 10), KHONG phai tien thue. Neu cot VAT trong hoac gach "-" (hang khong chiu thue) thi vatRate = 0. Chi de null khi anh mo khong doc duoc cot nay.',
        'Lay theo TUNG DONG: plantName=cot "Co so", proposedBy=cot "Nguoi de xuat", supplierName=cot "Nha cung cap/Nha cung", purpose=cot "Noi dung", note=cot "Ghi chu".',
        'Ngay (orderDate=Ngay len don, receivedDate=Ngay nhan): tra ve ISO YYYY-MM-DD (vd 1/6/2026 -> 2026-06-01). Khong doc duoc thi null.',
        'materialName giu nguyen ten hang nhu tren phieu. Bo qua dong tong cong/thanh tien tong/chu ky.',
        'Output schema (chi JSON):',
        '{"header":{"supplierName":null,"invoiceNo":null,"invoiceDate":null},"items":[{"materialName":"","unit":null,"quantityRequested":null,"quantity":null,"unitPrice":null,"vatRate":null,"plantName":null,"proposedBy":null,"supplierName":null,"purpose":null,"note":null,"orderDate":null,"receivedDate":null}]}',
    ].join('\n');

const buildSupplyPrompt = () =>
    [
        'Ban la tro ly OCR phieu de xuat cap vat tu cua cong ty may (tieng Viet).',
        'Doc anh dinh kem (phieu giay/anh chup bang Excel/danh sach vat tu can xin cap hoac da cap) va trich CHINH XAC thong tin de tao PHIEU DE XUAT CAP VAT TU.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'TUYET DOI khong bia: truong nao khong doc duoc thi de null.',
        'So luong tra ve SO thuan, KHONG dau phan cach nghin. Vi du "1.200" -> 1200, "12,5" -> 12.5.',
        'Uu tien doc cac cot: Ten vat tu/Ten vat tu hang hoa/Hang hoa/Noi dung, DVT/Don vi/Don vi tinh, So luong can/So luong/SL xin/SL de xuat, Ghi chu/Quy cach/Muc dich.',
        'Neu bang co ca "So luong can" va "So luong cap/So luong da cap" thi quantityRequested BAT BUOC lay tu "So luong can"; khong lay so luong cap neu cot can doc duoc.',
        'Neu anh la bang Excel crop ngang, hay doc theo tung hang du lieu ben duoi header. Vi du cot "Ten vat tu hang hoa" la materialName, cot "Don vi tinh" la unit, cot "So luong can" la quantityRequested.',
        'Neu co cot "Co so" hoac cot cuoi lap lai ten co so theo tung dong thi dua ten do vao header.plantName neu tat ca dong cung mot co so; neu khac nhau thi giu null.',
        'Neu co thong tin chung thi lay header.requestDate theo ISO YYYY-MM-DD, header.requesterName, header.plantName, header.note/purpose.',
        'materialName giu nguyen ten vat tu nhu tren phieu. Bo qua dong tong cong, tieu de, chu ky, nguoi duyet.',
        'note CHI ghi quy cach/mau sac/kich thuoc neu co; NGAN GON. TUYET DOI khong nhoi ten nguoi de xuat/nguoi nhan/ngay/don gia/thanh tien vao note (cac cot do bo qua).',
        'Output schema (chi JSON):',
        '{"header":{"requestDate":null,"requesterName":null,"plantName":null,"purpose":null,"note":null},"items":[{"materialName":"","unit":null,"quantityRequested":null,"purpose":null,"note":null}]}',
    ].join('\n');

const normalizeItems = (raw: any): OcrItem[] => {
    const rawItems = Array.isArray(raw?.items) ? raw.items : [];
    return rawItems
        .map((item: any) => ({
            materialName: cleanText(item?.materialName) || '',
            unit: cleanText(item?.unit),
            quantityRequested: cleanNumber(item?.quantityRequested),
            quantity: cleanNumber(item?.quantity),
            unitPrice: cleanNumber(item?.unitPrice),
            vatRate: cleanNumber(item?.vatRate),
            plantName: cleanText(item?.plantName),
            proposedBy: cleanText(item?.proposedBy),
            supplierName: cleanText(item?.supplierName),
            purpose: cleanText(item?.purpose),
            note: cleanText(item?.note),
            orderDate: cleanText(item?.orderDate),
            receivedDate: cleanText(item?.receivedDate),
        }))
        .filter((item: OcrItem) => item.materialName);
};

const normalizeSupplyItems = (raw: any): SupplyOcrItem[] => {
    const rawItems = Array.isArray(raw?.items) ? raw.items : [];
    return rawItems
        .map((item: any) => ({
            materialName: cleanText(item?.materialName) || '',
            unit: cleanText(item?.unit),
            quantityRequested: cleanNumber(item?.quantityRequested) ?? cleanNumber(item?.quantity),
            purpose: cleanText(item?.purpose),
            note: cleanText(item?.note),
        }))
        .filter((item: SupplyOcrItem) => item.materialName);
};

export const scanPurchaseInvoice = async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
        throw new BadRequestError('Chưa có ảnh hóa đơn để quét');
    }

    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    const attempt = async (model?: string) => {
        const aiResult = await aiProviderService.generateJson<any>({
            feature: 'ocr-invoice',
            model,
            temperature: 0.05,
            maxTokens: 6000,
            timeoutMs: 75000,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban trich xuat du lieu co cau truc tu anh phieu mua vat tu thanh JSON. Uu tien chinh xac, khong bia so lieu. Chi tra JSON.',
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: buildPrompt() },
                        { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                },
            ],
        });
        const items = normalizeItems(aiResult.data);
        if (!items.length) throw new Error('OCR returned no items');
        const header = {
            supplierName: cleanText(aiResult.data?.header?.supplierName),
            invoiceNo: cleanText(aiResult.data?.header?.invoiceNo),
            invoiceDate: cleanText(aiResult.data?.header?.invoiceDate),
        };
        return { aiResult, items, header };
    };

    try {
        // Thử lại nhiều lần (model chính x2 + model dự phòng): gemini đôi khi trả JSON bẩn/cắt cụt/rỗng.
        const { aiResult, items, header } = await runOcrWithRetry(attempt, OCR_PRIMARY_VISION_MODEL);

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    header,
                    items,
                    count: items.length,
                    available: true,
                    usedFallback: false,
                    provider: aiResult.provider,
                    model: aiResult.model,
                    latencyMs: aiResult.latencyMs,
                },
                message: `Đã quét được ${items.length} dòng vật tư`,
                status: StatusCodes.OK,
                success: true,
            })
        );
    } catch (error) {
        console.warn('[ai-ocr] purchase invoice OCR fallback:', error instanceof Error ? error.message : error);
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    header: {},
                    items: [],
                    count: 0,
                    available: false,
                    usedFallback: true,
                },
                message: 'Chưa đọc được hóa đơn. Hãy chụp rõ nét, đủ sáng và thẳng góc rồi thử lại.',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }
};

export const scanSupplyRequest = async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
        throw new BadRequestError('Chưa có ảnh phiếu đề xuất cấp để quét');
    }

    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    const attempt = async (model?: string) => {
        const aiResult = await aiProviderService.generateJson<any>({
            feature: AI_FEATURES.OCR_SUPPLY_REQUEST,
            model,
            temperature: 0.04,
            maxTokens: 6000,
            timeoutMs: 75000,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban trich xuat du lieu co cau truc tu anh phieu de xuat cap vat tu thanh JSON. Uu tien chinh xac, khong bia so lieu. Chi tra JSON.',
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: buildSupplyPrompt() },
                        { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                },
            ],
        });
        const items = normalizeSupplyItems(aiResult.data);
        if (!items.length) throw new Error('OCR returned no supply items');
        const header = {
            requestDate: cleanText(aiResult.data?.header?.requestDate),
            requesterName: cleanText(aiResult.data?.header?.requesterName),
            plantName: cleanText(aiResult.data?.header?.plantName),
            purpose: cleanText(aiResult.data?.header?.purpose),
            note: cleanText(aiResult.data?.header?.note),
        };
        return { aiResult, items, header };
    };

    try {
        // Thử lại nhiều lần (model chính x2 + model dự phòng) cho ổn định khi gemini trả rỗng/chập chờn.
        const { aiResult, items, header } = await runOcrWithRetry(attempt, OCR_PRIMARY_VISION_MODEL);

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    header,
                    items,
                    count: items.length,
                    available: true,
                    usedFallback: false,
                    provider: aiResult.provider,
                    model: aiResult.model,
                    latencyMs: aiResult.latencyMs,
                },
                message: `Đã quét được ${items.length} dòng vật tư cần cấp`,
                status: StatusCodes.OK,
                success: true,
            })
        );
    } catch (error) {
        console.warn('[ai-ocr] supply request OCR fallback:', error instanceof Error ? error.message : error);
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    header: {},
                    items: [],
                    count: 0,
                    available: false,
                    usedFallback: true,
                },
                message: 'Chưa đọc được phiếu đề xuất cấp. Hãy chụp rõ nét, đủ sáng và thẳng góc rồi thử lại.',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }
};
