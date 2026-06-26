import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError } from '@/errors/customError';
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
// DUNG (ép kiểu mềm, bỏ trường lỗi) + thử lại 1 lần cho ổn định.

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

export const scanPurchaseInvoice = async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
        throw new BadRequestError('Chưa có ảnh hóa đơn để quét');
    }

    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    const attempt = async () => {
        const aiResult = await aiProviderService.generateJson<any>({
            feature: 'ocr-invoice',
            temperature: 0.05,
            maxTokens: 4000,
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
        // Thử lại 1 lần: gemini đôi khi trả JSON bẩn/cắt cụt với output dài.
        const { aiResult, items, header } = await attempt().catch(() => attempt());

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
    } catch {
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
