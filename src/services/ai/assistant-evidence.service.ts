import type { AssistantToolName } from '@/services/ai/assistant-tool-registry.service';

export type AssistantRenderDomain = 'asset' | 'material' | 'cost' | 'mixed';

export type AssistantToolRender = {
    domain: AssistantRenderDomain;
    count: number;
    items: any[];
    aggregates: Record<string, any>;
    appliedFilters?: any;
    followups?: string[];
};

export type AssistantEvidenceEntry = {
    tool: AssistantToolName;
    data: any;
    render?: AssistantToolRender;
};

const itemIdentity = (item: any, index: number) => {
    if (!item || typeof item !== 'object') return `primitive:${index}:${String(item)}`;
    const identity =
        item._id ??
        item.id ??
        item.machineCode ??
        item.materialCode ??
        item.requestCode ??
        item.orderCode ??
        item.code ??
        item.serialNumber;
    return identity ? `id:${String(identity)}` : `anonymous:${index}:${JSON.stringify(item).slice(0, 180)}`;
};

export const mergeAssistantRenders = (
    current: AssistantToolRender | undefined,
    next: AssistantToolRender | undefined
): AssistantToolRender | undefined => {
    if (!next) return current;
    if (!current) {
        return {
            ...next,
            items: [...(next.items || [])],
            aggregates: { ...(next.aggregates || {}) },
        };
    }

    const itemMap = new Map<string, any>();
    [...(current.items || []), ...(next.items || [])].forEach((item, index) => {
        const key = itemIdentity(item, index);
        if (!itemMap.has(key)) itemMap.set(key, item);
    });
    const items = [...itemMap.values()].slice(0, 30);
    const sameDomain = current.domain === next.domain;

    return {
        domain: sameDomain ? current.domain : 'mixed',
        count: items.length || Math.max(current.count || 0, next.count || 0),
        items,
        aggregates: {
            ...(current.aggregates || {}),
            ...(next.aggregates || {}),
        },
        appliedFilters: next.appliedFilters ?? current.appliedFilters,
        followups: next.followups ?? current.followups,
    };
};

const compactJson = (value: unknown, maxLength: number) => {
    const json = JSON.stringify(value ?? null);
    return json.length <= maxLength ? json : `${json.slice(0, maxLength)}...`;
};

export const buildGroundingEvidence = (entries: AssistantEvidenceEntry[], maxLength = 14000) => {
    const perEntryBudget = Math.max(200, Math.floor((maxLength - 100) / Math.max(entries.length, 1)));
    // Mỗi phần tử là một JSON snippet dạng chuỗi: outer JSON luôn hợp lệ dù snippet phải cắt theo ngân sách.
    return JSON.stringify(
        entries.map((entry) =>
            compactJson(
                {
                    tool: entry.tool,
                    result: entry.data,
                    count: entry.render?.count,
                    aggregates: entry.render?.aggregates,
                    items: entry.render?.items?.slice(0, 12),
                    filters: entry.render?.appliedFilters,
                },
                perEntryBudget
            )
        )
    );
};
