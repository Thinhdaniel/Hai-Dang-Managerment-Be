import { ASSET_OWNERSHIP_TYPE } from '@/constant/assetStatus';

/**
 * Mã máy thông minh: {LOẠI}-{NHÃN}-{NGUỒN}-{STT}
 * Ví dụ: 1K-HIKARI-HD-001 (Máy 1 kim - Hikari - Hải Đăng - số thứ tự).
 */

// Mã nguồn gốc theo ownershipType (nằm trong mã máy nên cố định, chỉnh ở đây nếu cần).
export const ASSET_ORIGIN_CODE: Record<string, string> = {
    [ASSET_OWNERSHIP_TYPE.OWNED]: 'HD', // Hải Đăng (máy sở hữu)
    [ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED]: 'ĐT', // mượn đối tác
    [ASSET_OWNERSHIP_TYPE.RENTAL]: 'T', // thuê
};

export const DEFAULT_ORIGIN_CODE = 'HD';
export const SEQUENCE_PAD = 3; // 001, 002...

const stripDiacritics = (value: string) =>
    value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D');

/** Chuẩn hoá 1 chuỗi thành mã (bỏ dấu, viết hoa, chỉ giữ A-Z0-9). Dùng cho mã nhãn hiệu. */
export const normalizeForCode = (value?: string) =>
    stripDiacritics(String(value ?? ''))
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

/** Khoá ghi nhớ mã loại máy (không phân biệt hoa/thường, bỏ dấu, gộp khoảng trắng). */
export const normalizeTypeKey = (type?: string) =>
    stripDiacritics(String(type ?? ''))
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');

/**
 * Gợi ý mã viết tắt cho loại máy: bỏ chữ "máy", mỗi từ còn lại là số thì giữ số,
 * là chữ thì lấy chữ cái đầu. "Máy 1 kim" -> "1K", "Máy vắt sổ" -> "VS".
 */
export const suggestTypeCode = (type?: string) => {
    const normalized = normalizeTypeKey(type);
    if (!normalized) return '';

    const words = normalized
        .split(' ')
        .filter(Boolean)
        .filter((word) => word !== 'may');

    if (words.length === 0) return normalizeForCode(type).slice(0, 4);

    // Một token: nếu là dạng mã (có chữ số) hoặc viết tắt ngắn (<=3 ký tự) thì giữ nguyên cả token
    // (vd người dùng gõ thẳng "vs4c", "1k" -> VS4C, 1K); từ thường dài thì lấy chữ cái đầu (kansai -> K).
    // Token dài toàn PHỤ ÂM (không nguyên âm, không số) chắc chắn là viết tắt -> giữ nguyên (nhbl -> NHBL).
    if (words.length === 1) {
        const word = words[0];
        if (/[0-9]/.test(word) || word.length <= 3) return normalizeForCode(word);
        if (!/[aeiouy]/.test(word)) return normalizeForCode(word);
        return normalizeForCode(word[0]);
    }

    const code = words
        .map((word) => (/^\d+$/.test(word) ? word : word[0]))
        .join('')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

    return code || normalizeForCode(type).slice(0, 4);
};

export const padSequence = (seq: number) => String(seq).padStart(SEQUENCE_PAD, '0');

/** Ghép tiền tố mã máy (chưa có STT). */
export const buildMachineCodePrefix = (typeCode: string, brandCode: string, originCode: string) =>
    [typeCode, brandCode, originCode].filter(Boolean).join('-');
