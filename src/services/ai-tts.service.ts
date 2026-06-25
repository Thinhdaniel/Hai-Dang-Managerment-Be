import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// Đọc câu trả lời bằng GIỌNG NEURAL (Microsoft Edge TTS) — miễn phí, không cần API key.
// Đây chính là dòng giọng CapCut dùng cho tiếng Việt (HoaiMy/NamMinh): tự nhiên, không robot.
const VI_VOICES = new Set(['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural']);
const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';

// Chuẩn hoá text cho TTS: bỏ markdown/emoji + BIẾN xuống dòng/gạch đầu dòng thành DẤU CÂU
// để giọng neural NGHỈ NGẮT đúng nhịp (giống lời đọc review), và đọc đơn vị cho tự nhiên.
const cleanForSpeech = (t: string) =>
    (t || '')
        .replace(/\r/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '') // bỏ emoji
        .replace(/^\s*#{1,6}\s*/gm, '') // tiêu đề markdown
        .replace(/^\s*[-*•·–]\s+/gm, '. ') // gạch đầu dòng -> nghỉ như câu mới
        .replace(/\n{2,}/g, '. ') // đoạn mới -> nghỉ dài
        .replace(/\n/g, ', ') // xuống dòng đơn -> nghỉ ngắn
        .replace(/[*_`#>~|]/g, ' ') // ký tự markdown còn lại
        // đọc đơn vị cho tự nhiên (đứng sau số)
        .replace(/(\d)\s*đ(?!\p{L})/gu, '$1 đồng') // 896.020đ -> 896.020 đồng (đ không thuộc \w nên không dùng \b)
        .replace(/(\d)\s*%/g, '$1 phần trăm')
        .replace(/VN[ĐD](?!\p{L})/giu, 'đồng')
        // gọn khoảng trắng nhưng GIỮ dấu câu để engine ngắt nhịp
        .replace(/[ \t]+/g, ' ')
        .replace(/\s+([.,;:!?])/g, '$1') // không để khoảng trắng trước dấu câu
        .replace(/([.;:!?])\s*,/g, '$1') // dấu mạnh + phẩy -> giữ dấu mạnh
        .replace(/,\s*([.;:!?])/g, '$1') // phẩy + dấu mạnh -> giữ dấu mạnh
        .replace(/([.,;:!?])(?:\s*\1)+/g, '$1') // gộp dấu câu lặp (". . ." -> ".")
        .replace(/\s+/g, ' ')
        .trim();

// Chỉ nhận chuỗi prosody hợp lệ kiểu "+18%" / "-6%" (chống chèn bậy vào SSML).
const safeProsody = (v: unknown, fallback: string) =>
    typeof v === 'string' && /^[+-]?\d{1,3}%$/.test(v) ? v : fallback;

export const synthesizeSpeech = async (req: Request, res: Response) => {
    const text = cleanForSpeech(String(req.body?.text || '')).slice(0, 1500);
    if (!text) {
        return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: 'Thiếu text' });
    }
    const voice = VI_VOICES.has(req.body?.voice) ? req.body.voice : DEFAULT_VOICE;
    const rate = safeProsody(req.body?.rate, '+0%');
    const pitch = safeProsody(req.body?.pitch, '+0%');

    const tts = new MsEdgeTTS();
    try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text, { rate, pitch });

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');

        audioStream.on('data', (chunk: Buffer) => res.write(chunk));
        audioStream.on('end', () => {
            try {
                tts.close();
            } catch {
                /* noop */
            }
            res.end();
        });
        audioStream.on('error', () => {
            try {
                tts.close();
            } catch {
                /* noop */
            }
            if (!res.headersSent) res.status(StatusCodes.BAD_GATEWAY).json({ success: false, message: 'TTS loi' });
            else res.end();
        });
    } catch {
        try {
            tts.close();
        } catch {
            /* noop */
        }
        if (!res.headersSent) {
            return res.status(StatusCodes.BAD_GATEWAY).json({ success: false, message: 'Khong tao duoc giong doc' });
        }
        res.end();
    }
};
