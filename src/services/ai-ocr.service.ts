import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { BadRequestError } from '@/errors/customError';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import customResponse from '@/utils/response';

// OCR ảnh hóa đơn/phiếu mua vật tư -> trích dòng có cấu trúc để điền sẵn đơn mua.
// Dùng model VISION (gc/gemini-2.5-flash) qua 9router. Ảnh nằm trong RAM (multer memory),
// chuyển base64 gửi thẳng cho model — KHÔNG lưu trữ ảnh.

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
                quantity: nullableNum,
                unitPrice: nullableNum,
                vatRate: nullableNum,
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
        'Ban la tro ly OCR hoa don / phieu mua vat tu cua cong ty may (tieng Viet).',
        'Doc anh dinh kem va trich CHINH XAC cac dong vat tu + thong tin chung.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'TUYET DOI khong bia: truong nao khong doc duoc thi de null (hoac bo qua neu khong chac).',
        'So tien/so luong: tra ve SO thuan (vd "1.200.000" -> 1200000, "12,5" -> 12.5). Don gia tinh theo VND.',
        'vatRate la phan tram thue (vd 8, 10). materialName giu nguyen ten nhu tren hoa don.',
        'Chi lay cac DONG VAT TU thuc su; bo qua dong tong cong/thanh tien/chu ky.',
        'Output schema:',
        '{"header":{"supplierName":"ten NCC hoac null","invoiceNo":"so hoa don hoac null","invoiceDate":"ngay tren hoa don hoac null"},"items":[{"materialName":"ten vat tu","unit":"don vi hoac null","quantity":0,"unitPrice":0,"vatRate":0}]}',
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
            maxTokens: 2400,
            timeoutMs: 60000,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban trich xuat du lieu co cau truc tu anh hoa don mua vat tu thanh JSON. Uu tien chinh xac, khong bia so lieu.',
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
                quantity: cleanNumber(item.quantity),
                unitPrice: cleanNumber(item.unitPrice),
                vatRate: cleanNumber(item.vatRate),
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
