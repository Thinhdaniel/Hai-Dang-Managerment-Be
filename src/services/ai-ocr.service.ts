import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
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

const nullableStr = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableNum = z.union([z.number(), z.null()]).optional();

const invoiceSchema = z.object({
    header: z
        .object({
            supplierName: nullableStr(200),
            invoiceNo: nullableStr(100),
            invoiceDate: nullableStr(40),
        })
        .partial()
        .optional()
        .default({}),
    items: z
        .array(
            z.object({
                materialName: z.string().trim().min(1).max(300),
                unit: nullableStr(40),
                // Hai cột số lượng tách biệt trên phiếu thật:
                quantityRequested: nullableNum, // "Số lượng cần"
                quantity: nullableNum, // "Số lượng" (số mua/ghi hóa đơn, khớp thành tiền)
                unitPrice: nullableNum,
                vatRate: nullableNum,
                plantName: nullableStr(120), // "Cơ sở"
                proposedBy: nullableStr(120), // "Người đề xuất"
                supplierName: nullableStr(200), // "Nhà cung cấp"
                purpose: nullableStr(300), // "Nội dung" / mục đích
                note: nullableStr(300), // "Ghi chú"
                orderDate: nullableStr(40), // "Ngày lên đơn" (ISO)
                receivedDate: nullableStr(40), // "Ngày nhận" (ISO)
            })
        )
        .max(80)
        .default([]),
});

type InvoiceData = z.infer<typeof invoiceSchema>;

const cleanNumber = (value: unknown): number | undefined => {
    if (value == null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const cleanText = (value: unknown): string | undefined => {
    const text = String(value ?? '').trim();
    return text || undefined;
};

const buildPrompt = () =>
    [
        'Ban la tro ly OCR phieu/hoa don mua vat tu cua cong ty may (tieng Viet).',
        'Doc anh dinh kem (thuong la BANG "DANH SACH MUA VAT TU") va trich CHINH XAC tung dong + thong tin chung.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'TUYET DOI khong bia: truong nao khong doc duoc thi de null.',
        'So tien/so luong: tra ve SO thuan (vd "1.200.000" -> 1200000, "12,5" -> 12.5). Don gia theo VND.',
        'PHAN BIET 2 cot so luong neu co: "So luong can" -> quantityRequested; "So luong" (cot gan don gia, khop thanh tien) -> quantity.',
        'vatRate la phan tram thue (vd 8, 10), khong phai tien thue. Neu o trong/gach "-" thi de null.',
        'Lay theo TUNG DONG: plantName=cot "Co so", proposedBy=cot "Nguoi de xuat", supplierName=cot "Nha cung cap/Nha cung", purpose=cot "Noi dung", note=cot "Ghi chu".',
        'Ngay (orderDate=Ngay len don, receivedDate=Ngay nhan): tra ve ISO YYYY-MM-DD (vd 1/6/2026 -> 2026-06-01). Khong doc duoc thi null.',
        'materialName giu nguyen ten hang nhu tren phieu. Bo qua dong tong cong/thanh tien tong/chu ky.',
        'Output schema:',
        '{"header":{"supplierName":null,"invoiceNo":null,"invoiceDate":null},"items":[{"materialName":"","unit":null,"quantityRequested":null,"quantity":null,"unitPrice":null,"vatRate":null,"plantName":null,"proposedBy":null,"supplierName":null,"purpose":null,"note":null,"orderDate":null,"receivedDate":null}]}',
    ].join('\n');

export const scanPurchaseInvoice = async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
        throw new BadRequestError('Chưa có ảnh hóa đơn để quét');
    }

    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    try {
        const aiResult = await aiProviderService.generateJson<InvoiceData>({
            feature: 'ocr-invoice',
            temperature: 0.05,
            maxTokens: 3600,
            timeoutMs: 70000,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban trich xuat du lieu co cau truc tu anh phieu mua vat tu thanh JSON. Uu tien chinh xac, khong bia so lieu.',
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

        const parsed = invoiceSchema.parse(aiResult.data);
        const items = parsed.items
            .map((item) => ({
                materialName: String(item.materialName).trim(),
                unit: cleanText(item.unit),
                quantityRequested: cleanNumber(item.quantityRequested),
                quantity: cleanNumber(item.quantity),
                unitPrice: cleanNumber(item.unitPrice),
                vatRate: cleanNumber(item.vatRate),
                plantName: cleanText(item.plantName),
                proposedBy: cleanText(item.proposedBy),
                supplierName: cleanText(item.supplierName),
                purpose: cleanText(item.purpose),
                note: cleanText(item.note),
                orderDate: cleanText(item.orderDate),
                receivedDate: cleanText(item.receivedDate),
            }))
            .filter((item) => item.materialName);

        const header = {
            supplierName: cleanText(parsed.header?.supplierName),
            invoiceNo: cleanText(parsed.header?.invoiceNo),
            invoiceDate: cleanText(parsed.header?.invoiceDate),
        };

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
                message: items.length
                    ? `Đã quét được ${items.length} dòng vật tư`
                    : 'Không đọc được dòng vật tư nào — thử chụp rõ hơn',
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
