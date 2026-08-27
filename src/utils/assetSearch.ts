import { buildSearchRegex, normalizeSearchTerm } from '@/utils/search';

export const ASSET_SEARCH_FIELDS = ['name', 'machineCode', 'serial', 'type', 'model'] as const;

type AssetSearchField = (typeof ASSET_SEARCH_FIELDS)[number];

export type AssetSearchCondition = {
    $or: Array<Partial<Record<AssetSearchField, RegExp>>>;
};

const EDGE_PUNCTUATION = /^[()[\]{}.,;:!?"'“”‘’]+|[()[\]{}.,;:!?"'“”‘’]+$/g;

export const tokenizeAssetSearch = (value: unknown) => {
    const normalized = normalizeSearchTerm(value);
    if (!normalized) return [];

    return [
        ...new Set(
            normalized
                .split(/\s+/)
                .map((token) => token.replace(EDGE_PUNCTUATION, '').trim())
                .filter(Boolean)
        ),
    ];
};

/**
 * UI danh sách và trợ lý AI phải dùng cùng một ngữ nghĩa tìm kiếm:
 * mỗi token xuất hiện ở ít nhất một trường máy, các token kết hợp theo AND.
 */
export const buildAssetSearchConditions = (value: unknown): AssetSearchCondition[] =>
    tokenizeAssetSearch(value).flatMap((token) => {
        const regex = buildSearchRegex(token);
        if (!regex) return [];

        return [
            {
                $or: ASSET_SEARCH_FIELDS.map((field) => ({ [field]: regex })),
            },
        ];
    });
