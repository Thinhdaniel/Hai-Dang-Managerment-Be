export const normalizeSearchTerm = (value: unknown) =>
    String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Moi nguyen am/phu am goc -> lop ky tu chua moi bien the co dau (de search khong phu thuoc dau)
const VI_CHAR_CLASS: Record<string, string> = {
    a: 'aàáảãạăằắẳẵặâầấẩẫậ',
    e: 'eèéẻẽẹêềếểễệ',
    i: 'iìíỉĩị',
    o: 'oòóỏõọôồốổỗộơờớởỡợ',
    u: 'uùúủũụưừứửữự',
    y: 'yỳýỷỹỵ',
    d: 'dđ',
};

// Bo dau + ha chu thuong de dua tu khoa nguoi dung ve dang goc
const stripDiacritics = (value: string) =>
    value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd');

export const buildSearchRegex = (value: unknown, options?: { flexibleWhitespace?: boolean }) => {
    const normalized = normalizeSearchTerm(value);

    if (!normalized) {
        return undefined;
    }

    // Dua ve goc roi mo rong tung ky tu thanh lop bien the co dau; van escape ky tu dac biet regex.
    const base = stripDiacritics(normalized);
    let pattern = Array.from(base)
        .map((char) => (VI_CHAR_CLASS[char] ? `[${VI_CHAR_CLASS[char]}]` : escapeRegExp(char)))
        .join('');

    if (options?.flexibleWhitespace) {
        pattern = pattern.replace(/\s+/g, '[-\\s]*');
    }

    return new RegExp(pattern, 'i');
};
