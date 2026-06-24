import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// Đọc câu trả lời bằng GIỌNG NEURAL (Microsoft Edge TTS) — miễn phí, không cần API key.
// Đây chính là dòng giọng CapCut dùng cho tiếng Việt (HoaiMy/NamMinh): tự nhiên, không robot.
const VI_VOICES = new Set(['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural']);
const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';

// Bỏ markdown/emoji để đọc tự nhiên.
const cleanForSpeech = (t: string) =>
    (t || '')
        .replace(/[*_`#>~|]/g, ' ')
        .replace(/\p{Extended_Pictographic}/gu, '')
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
