export const normalizeSearchTerm = (value: unknown) => String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const buildSearchRegex = (value: unknown, options?: { flexibleWhitespace?: boolean }) => {
    const normalized = normalizeSearchTerm(value);

    if (!normalized) {
        return undefined;
    }

    const escaped = escapeRegExp(normalized);
    const pattern = options?.flexibleWhitespace ? escaped.replace(/\s+/g, '[-\\s]*') : escaped;

    return new RegExp(pattern, 'i');
};
