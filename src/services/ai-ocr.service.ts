import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import streamifier from 'streamifier';
import cloudinaryConfig from '@/config/cloudinary.config';
import { BadRequestError } from '@/errors/customError';
import { AI_FEATURES } from '@/constant/aiModels';
import config from '@/config/env.config';
import { aiProviderService, type AiGenerateTextOptions } from '@/services/ai/ai-provider.service';
import { vertexProviderService } from '@/services/ai/vertex-provider.service';
import customResponse from '@/utils/response';

cloudinary.config(cloudinaryConfig);

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

// Model vision cho OCR. LƯU Ý: gemini-2.5-flash NAY ĐÃ BẬT "thinking" mặc định (đốt 2.6k–5.7k
// token suy luận) -> nếu để mặc định, nó ngốn hết max_tokens, JSON bị CẮT CỤT -> parse lỗi -> quét
// thất bại (fallback rỗng). Vì vậy call OCR kèm reasoningEffort:'low' + maxTokens dư (xem generateJson
// bên dưới): đủ suy luận để MAP CỘT chuẩn, vừa không cắt cụt. ('none' nhanh hơn nhưng map ẩu.)
const OCR_RELIABLE_VISION_MODEL = 'gc/gemini-2.5-flash';

// CHỈ honor AI_OCR_MODEL riêng cho OCR (KHÔNG kế thừa AI_VISION_MODEL chung — env đó có thể là
// model thinking khiến OCR cắt cụt). Không set thì mặc định model ổn định ở trên.
const OCR_PRIMARY_VISION_MODEL = process.env.AI_OCR_MODEL || OCR_RELIABLE_VISION_MODEL;

// Model cho lần thử cuối (cấu hình qua env). Mặc định vẫn flash (non-thinking) cho an toàn.
const OCR_FALLBACK_VISION_MODEL = process.env.AI_OCR_FALLBACK_MODEL || OCR_RELIABLE_VISION_MODEL;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const generateOcrJson = async <T>(
    options: AiGenerateTextOptions,
    vertexModel = config.vertex.visionModel
) => {
    if (vertexProviderService.isEnabled()) {
        try {
            return await vertexProviderService.generateJson<T>({
                ...options,
                model: vertexModel,
                timeoutMs: Math.max(options.timeoutMs ?? 0, config.vertex.timeoutMs),
            });
        } catch (error) {
            console.warn('[vertex-ocr] failed, fallback to 9router:', error instanceof Error ? error.message : error);
        }
    }
    return aiProviderService.generateJson<T>(options);
};

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
        'Ban la tro ly OCR phieu/hoa don MUA VAT TU cua cong ty may (tieng Viet). Doc anh va trich CHINH XAC tung dong + thong tin chung.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON. TUYET DOI khong bia: truong nao khong doc duoc thi de null.',
        'Anh THUONG la bang "DANH SACH MUA VAT TU" cua cong ty, THU TU COT tu TRAI->PHAI nhu sau (map DUNG theo VI TRI cot):',
        '  1)STT  2)Ten vat tu (materialName)  3)Co so (plantName)  4)Nguoi de xuat (proposedBy = TEN NGUOI)  5)So luong can (quantityRequested)  6)DVT (unit)  7)So luong mua (quantity)  8)Don gia (unitPrice)  9)Thanh tien [BO QUA]  10)VAT % (vatRate)  11)Tien thue VAT [BO QUA]  12)Tong cong [BO QUA]  13)Ngay len don (orderDate)  14)Ngay nhan (receivedDate)  15)Trang thai thanh toan [BO QUA]  16)Nha cung cap (supplierName = NOI MUA)  17)Noi dung/Muc dich (purpose).',
        'CUC KY QUAN TRONG — dung nham 2 cot khac nhau: cot 3 "Co so" (don vi NOI BO nhan hang, vd "Dai Pham","Co so 1","Co so 2","Phu Son") KHAC HOAN TOAN cot 16 "Nha cung cap" (noi BAN, vd "Khai Quang","Hoan Linh","Tap hoa","Shoppe"). TUYET DOI khong gan ten co so vao supplierName va nguoc lai.',
        'Cot 4 "Nguoi de xuat" la TEN NGUOI (vd "A Tuan CK","Quyen","Nhung","Long") — dung nham voi ten co so/NCC.',
        'PHAN BIET 2 cot so luong: cot 5 "So luong can" -> quantityRequested; cot 7 "So luong (mua)" (gan don gia, khop thanh tien) -> quantity.',
        'vatRate = phan tram thue (vd 8, 10), KHONG phai tien thue. Neu o VAT TRONG hoac gach "-" (hang khong chiu thue) thi vatRate = 0 (KHONG de null).',
        'Neu anh KHONG theo mau tren (hoa don NCC ngoai, layout khac) thi map theo TIEU DE COT / y nghia tung cot.',
        'So tien/so luong tra ve SO thuan, KHONG dau phan cach nghin (vd "2.559.600" -> 2559600, "12,5" -> 12.5). Ngay tra ISO YYYY-MM-DD (vd 23/6/2026 -> 2026-06-23).',
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
        const aiResult = await generateOcrJson<any>({
            feature: 'ocr-invoice',
            model,
            temperature: 0.05,
            // reasoning 'low': ĐỦ suy luận để MAP CỘT chuẩn (phân biệt Cơ sở vs NCC, VAT trống=0, SL cần vs
            // SL mua) nhưng KHÔNG đốt hết token như mặc định (gemini-2.5-flash nay bật thinking rất nặng ->
            // JSON cắt cụt -> quét hỏng). 'none' map ẩu (bỏ qua rule VAT=0); 'low' chuẩn hơn, vẫn nhanh.
            reasoningEffort: 'low',
            // Dư maxTokens để reasoning(low ~1k) + JSON đầy đủ (phiếu nhiều dòng) không bị cắt cụt.
            maxTokens: 16000,
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
        const aiResult = await generateOcrJson<any>({
            feature: AI_FEATURES.OCR_SUPPLY_REQUEST,
            model,
            temperature: 0.04,
            // reasoning 'low' + dư maxTokens (xem giải thích ở scanPurchaseInvoice): map cột chuẩn mà không cắt cụt.
            reasoningEffort: 'low',
            maxTokens: 16000,
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

// ===== OCR tem thông số máy (nameplate) =====
// Chụp 2-3 ảnh tem/nhãn trên thân máy -> trích nhãn hiệu, model, serial (+ gợi ý tên) để điền
// sẵn form nhận máy mượn/thêm máy. Ảnh đồng thời được upload Cloudinary để user chọn 1 ảnh
// lưu vào hồ sơ máy — vì vậy khác các OCR trên, ảnh ở đây CÓ lưu trữ.

const uploadMachineImage = (file: Express.Multer.File): Promise<{ url: string }> =>
    new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: 'hai-dang/assets/machines',
                resource_type: 'image',
                tags: ['machine-label'],
            },
            (error, result?: UploadApiResponse) => {
                if (error || !result) {
                    reject(error || new Error('Upload anh may that bai'));
                    return;
                }
                resolve({ url: result.secure_url });
            }
        );
        streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });

const buildMachineLabelPrompt = () =>
    [
        'Cac anh sau chup TEM THONG SO (nameplate) va than mot may may cong nghiep (hoac may moc nha xuong).',
        'Trich thong tin dinh danh may. Cac nhan hieu pho bien: JUKI, BROTHER, PEGASUS, SIRUBA, KANSAI, YAMATO, KINGTEX, SUNSTAR, ZOJE, JACK, TYPICAL, HIKARI, MAQI, KWANGSUNG...',
        'Quy tac:',
        '- brand: ten nhan hieu in lon nhat tren tem/than may. Chi ten hang, khong kem model.',
        '- model: ma model (thuong ghi MODEL/TYPE/STYLE tren tem, vd DDL-8100e, M700, W500).',
        '- serial: so serial (thuong ghi SERIAL NO / SER.NO / S/N / NO.). Doc CHINH XAC tung ky tu, khong doan.',
        '- name: goi y ten may tieng Viet ngan gon theo chuc nang neu nhan ra duoc (vd "May 1 kim", "May vat so 4 chi", "May tran de"). Khong chac thi de null.',
        '- Khong thay ro truong nao thi de null, TUYET DOI khong bia.',
        'Tra ve DUY NHAT JSON: {"brand": string|null, "model": string|null, "serial": string|null, "name": string|null}',
    ].join('\n');

export const scanMachineLabel = async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length || !files.every((file) => file.buffer?.length)) {
        throw new BadRequestError('Chưa có ảnh máy để đọc');
    }

    // Upload ảnh song song với việc gọi AI — ảnh luôn được lưu kể cả khi AI đọc lỗi,
    // để user vẫn chọn được ảnh đại diện và tự điền tay.
    const uploadPromise = Promise.all(files.map((file) => uploadMachineImage(file)));

    const imageContents = files.map((file) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` },
    }));

    const attempt = async (model?: string) => {
        const aiResult = await generateOcrJson<any>({
            feature: AI_FEATURES.OCR_MACHINE_LABEL,
            model,
            temperature: 0.05,
            // reasoning 'low' + maxTokens dư: tránh bẫy thinking cắt cụt JSON (xem scanPurchaseInvoice).
            reasoningEffort: 'low',
            maxTokens: 8000,
            timeoutMs: 75000,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ban doc tem thong so may moc tu anh va trich JSON. Uu tien chinh xac, khong bia du lieu. Chi tra JSON.',
                },
                {
                    role: 'user',
                    content: [{ type: 'text', text: buildMachineLabelPrompt() }, ...imageContents],
                },
            ],
        });
        const fields = {
            brand: cleanText(aiResult.data?.brand),
            model: cleanText(aiResult.data?.model),
            serial: cleanText(aiResult.data?.serial),
            name: cleanText(aiResult.data?.name),
        };
        if (!fields.brand && !fields.model && !fields.serial) throw new Error('OCR returned no machine fields');
        return { aiResult, fields };
    };

    let ocr: Awaited<ReturnType<typeof attempt>> | null = null;
    try {
        ocr = await runOcrWithRetry(attempt, OCR_PRIMARY_VISION_MODEL);
    } catch (error) {
        console.warn('[ai-ocr] machine label OCR fallback:', error instanceof Error ? error.message : error);
    }

    const images = await uploadPromise;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                fields: ocr?.fields ?? {},
                images,
                available: Boolean(ocr),
                provider: ocr?.aiResult.provider,
                model: ocr?.aiResult.model,
                latencyMs: ocr?.aiResult.latencyMs,
            },
            message: ocr
                ? 'Đã đọc thông tin máy từ ảnh'
                : 'Chưa đọc được tem máy — ảnh đã lưu, bạn điền tay giúp nhé. Chụp sát tem, đủ sáng rồi thử lại.',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
