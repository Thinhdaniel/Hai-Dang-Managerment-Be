import { z } from 'zod';
import { AI_FEATURES } from '@/constant/aiModels';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import {
    actionUrlFor,
    buildDeterministicBriefingContent,
    containsNumericClaim,
} from '@/services/executive-briefing.helpers';
import type {
    BriefingActionKey,
    BriefingContentItem,
    BriefingFallbackCode,
    BriefingPeriodRange,
    ExecutiveBriefingContent,
    ExecutiveBriefingSnapshot,
} from '@/types/executiveBriefing';

const ACTION_KEYS = [
    'maintenance_overdue',
    'maintenance_list',
    'inventory_low_stock',
    'purchase_requests',
    'purchase_shortages',
    'supply_shortages',
    'transfer_backlog',
    'location_mismatch',
    'stocktake_anomaly',
    'qr_gap',
    'facility_report',
] as const;

const aiItemSchema = z.object({
    title: z.string().trim().min(4).max(140),
    detail: z.string().trim().min(8).max(360),
    severity: z.enum(['positive', 'info', 'warning', 'critical']),
    evidenceKeys: z.array(z.string().trim().min(1).max(100)).min(1).max(4),
    actionKey: z.enum(ACTION_KEYS).optional(),
    actionLabel: z.string().trim().min(2).max(60).optional(),
});

type AiBriefingItem = z.infer<typeof aiItemSchema>;
type AiBriefing = {
    summary: string;
    highlights: AiBriefingItem[];
    risks: AiBriefingItem[];
    actions: AiBriefingItem[];
};

type JsonRecord = Record<string, unknown>;
const ACTION_KEY_SET = new Set<string>(ACTION_KEYS);

const asRecord = (value: unknown): JsonRecord | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

const pickString = (record: JsonRecord, keys: string[]) => {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
};

const pickArray = (record: JsonRecord, keys: string[]) => {
    for (const key of keys) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    return [];
};

const cleanAiText = (value: string, maxLength: number) =>
    value
        .replace(/\b\d[\d.,:/%+-]*\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
        .trim();

const normalizeSeverity = (value: unknown, fallback: AiBriefingItem['severity']) => {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase();
    const aliases: Record<string, AiBriefingItem['severity']> = {
        positive: 'positive',
        success: 'positive',
        good: 'positive',
        info: 'info',
        neutral: 'info',
        low: 'info',
        warning: 'warning',
        warn: 'warning',
        medium: 'warning',
        caution: 'warning',
        critical: 'critical',
        high: 'critical',
        urgent: 'critical',
        error: 'critical',
    };
    return aliases[normalized] ?? fallback;
};

const normalizeEvidenceKeys = (value: unknown) => {
    const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\s]+/) : [];
    return [
        ...new Set(
            rows
                .map((entry) => {
                    if (typeof entry === 'string') return entry.trim();
                    const record = asRecord(entry);
                    return record ? pickString(record, ['key', 'evidenceKey', 'evidence_key']) : '';
                })
                .filter(Boolean)
        ),
    ].slice(0, 4);
};

const normalizeAiItem = (value: unknown, fallbackSeverity: AiBriefingItem['severity']): AiBriefingItem | null => {
    const record = asRecord(value);
    if (!record) return null;

    const rawDetail = pickString(record, ['detail', 'description', 'message', 'analysis', 'text']);
    const rawTitle = pickString(record, ['title', 'headline', 'name', 'label']) || rawDetail.split(/[.!?\n]/)[0] || '';
    const title = cleanAiText(rawTitle, 140);
    const detail = cleanAiText(rawDetail || rawTitle, 360);
    const evidenceKeys = normalizeEvidenceKeys(
        record.evidenceKeys ?? record.evidence_keys ?? record.evidence ?? record.sources
    );
    const rawActionKey = pickString(record, ['actionKey', 'action_key', 'action']);
    const actionKey = ACTION_KEY_SET.has(rawActionKey) ? rawActionKey : undefined;
    const actionLabel = cleanAiText(pickString(record, ['actionLabel', 'action_label', 'cta', 'buttonLabel']), 60);
    const parsed = aiItemSchema.safeParse({
        title,
        detail,
        severity: normalizeSeverity(record.severity ?? record.level ?? record.priority, fallbackSeverity),
        evidenceKeys,
        ...(actionKey ? { actionKey } : {}),
        ...(actionLabel.length >= 2 ? { actionLabel } : {}),
    });
    return parsed.success ? parsed.data : null;
};

export const parseExecutiveBriefingAiResponse = (data: unknown): AiBriefing => {
    const outer = asRecord(data);
    if (!outer) throw new Error('AI briefing schema: response root must be an object');

    const insightKeys = [
        'highlights',
        'positiveSignals',
        'achievements',
        'diemNoiBat',
        'risks',
        'warnings',
        'issues',
        'ruiRo',
        'actions',
        'recommendations',
        'nextActions',
        'hanhDong',
    ];
    const wrapped = ['briefing', 'data', 'result', 'content']
        .map((key) => asRecord(outer[key]))
        .find((record) => record && insightKeys.some((key) => key in record));
    const root = wrapped ?? outer;
    const parseItems = (rows: unknown[], severity: AiBriefingItem['severity'], limit: number) =>
        rows
            .map((row) => normalizeAiItem(row, severity))
            .filter((row): row is AiBriefingItem => Boolean(row))
            .slice(0, limit);

    const parsed = {
        summary: cleanAiText(pickString(root, ['summary', 'overview', 'executiveSummary']), 1200),
        highlights: parseItems(
            pickArray(root, ['highlights', 'positiveSignals', 'achievements', 'diemNoiBat']),
            'info',
            4
        ),
        risks: parseItems(pickArray(root, ['risks', 'warnings', 'issues', 'ruiRo']), 'warning', 5),
        actions: parseItems(pickArray(root, ['actions', 'recommendations', 'nextActions', 'hanhDong']), 'info', 4),
    };

    if (!parsed.highlights.length && !parsed.risks.length && !parsed.actions.length) {
        throw new Error('AI briefing schema: response has no usable insight items');
    }
    return parsed;
};

const SYSTEM_PROMPT = [
    'Bạn là chuyên viên phân tích vận hành cho ban giám đốc công ty may.',
    'Đầu vào chỉ gồm snapshot đã được backend tính và evidence catalog.',
    'Viết tiếng Việt ngắn, thẳng, chuyên nghiệp; không dùng emoji, khẩu hiệu hoặc ngôn ngữ quảng cáo.',
    'TUYỆT ĐỐI không viết chữ số trong summary, title hoặc detail. UI sẽ hiển thị số từ evidence để tránh sai số.',
    'Mỗi mục bắt buộc có evidenceKeys tồn tại trong catalog. Không suy diễn nguyên nhân khi dữ liệu không chứng minh.',
    'Không cộng giá trị đơn mua với giá trị cấp phát. Đây là hai góc nhìn khác nhau và có thể ghi nhận cùng một vật tư.',
    'Ưu tiên vấn đề có thể hành động: bảo trì quá hạn, tồn thấp, hàng thiếu, sai vị trí, kiểm kê và độ phủ QR.',
    'Không tự xếp hạng cơ sở bằng điểm số; chỉ mô tả chỉ số trực tiếp được cung cấp.',
    'Trả về duy nhất JSON đúng schema được yêu cầu.',
].join('\n');

const buildAiDataset = (period: BriefingPeriodRange, snapshot: ExecutiveBriefingSnapshot) => ({
    period: {
        label: period.periodLabel,
        comparisonLabel: period.comparisonLabel,
    },
    evidence: snapshot.evidence.map((entry) => ({
        key: entry.key,
        label: entry.label,
        value: entry.formattedValue,
        previous: entry.formattedPrevious,
        deltaPct: entry.deltaPct,
        tone: entry.tone,
    })),
    plantSignals: snapshot.plants.slice(0, 8).map((plant) => ({
        plantName: plant.plantName,
        availabilityPct: plant.availabilityPct,
        overdueTickets: plant.overdueTickets,
        lowStockCount: plant.lowStockCount,
        stocktakeAnomalies: plant.stocktakeAnomalies,
        attentionLevel: plant.attentionLevel,
    })),
    dataWarnings: snapshot.dataWarnings,
    responseSchema: {
        summary: 'string, không chứa chữ số',
        highlights: [
            {
                title: 'string',
                detail: 'string',
                severity: 'positive|info',
                evidenceKeys: ['evidence.key'],
                actionKey: 'optional',
                actionLabel: 'optional',
            },
        ],
        risks: [
            {
                title: 'string',
                detail: 'string',
                severity: 'warning|critical',
                evidenceKeys: ['evidence.key'],
                actionKey: 'optional',
                actionLabel: 'optional',
            },
        ],
        actions: [
            {
                title: 'string',
                detail: 'string',
                severity: 'info|warning|critical',
                evidenceKeys: ['evidence.key'],
                actionKey: ACTION_KEYS.join('|'),
                actionLabel: 'string',
            },
        ],
    },
});

const normalizeItems = (
    kind: 'highlight' | 'risk' | 'action',
    rows: AiBriefing['highlights'],
    validEvidence: Set<string>
): BriefingContentItem[] =>
    rows
        .map((row, index): BriefingContentItem | null => {
            const evidenceKeys = [...new Set(row.evidenceKeys.filter((key) => validEvidence.has(key)))];
            if (!evidenceKeys.length || containsNumericClaim(row.title) || containsNumericClaim(row.detail)) {
                return null;
            }
            return {
                id: `ai-${kind}-${index + 1}`,
                title: row.title,
                detail: row.detail,
                severity: row.severity,
                evidenceKeys,
                ...(row.actionKey ? { actionKey: row.actionKey as BriefingActionKey } : {}),
                ...(row.actionLabel ? { actionLabel: row.actionLabel } : {}),
                ...(row.actionKey ? { actionUrl: actionUrlFor(row.actionKey as BriefingActionKey) } : {}),
            };
        })
        .filter((row): row is BriefingContentItem => row !== null);

export const mergeGroundedItems = (
    aiItems: BriefingContentItem[],
    deterministic: BriefingContentItem[],
    limit: number
) => {
    if (!aiItems.length) return deterministic.slice(0, limit);
    const deterministicTitles = new Set(deterministic.map((entry) => entry.title.trim().toLowerCase()));
    const additions = aiItems.filter((entry) => !deterministicTitles.has(entry.title.trim().toLowerCase()));
    if (!additions.length) return deterministic.slice(0, limit);
    return [...deterministic.slice(0, Math.max(0, limit - 1)), additions[0]].slice(0, limit);
};

export type GeneratedBriefingContent = {
    content: ExecutiveBriefingContent;
    generationStatus: 'ready' | 'degraded';
    provider: string;
    model?: string;
    latencyMs?: number;
    fallbackCode?: BriefingFallbackCode;
    fallbackReason?: string;
    aiContributionCount?: number;
};

export const describeExecutiveBriefingAiFailure = (error: unknown): { code: BriefingFallbackCode; reason: string } => {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const message = raw.toLowerCase();

    if (message.includes('disabled')) {
        return { code: 'ai_disabled', reason: 'Nhà cung cấp AI đang bị tắt trong cấu hình hệ thống.' };
    }
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api key|required for remote/.test(message)) {
        return { code: 'authentication', reason: 'Kết nối AI chưa xác thực được với nhà cung cấp.' };
    }
    if (/\b429\b|rate.?limit|quota|credit|depleted|resource.?exhausted/.test(message)) {
        return { code: 'quota', reason: 'Nhà cung cấp AI đang giới hạn lượt gọi hoặc đã hết hạn mức.' };
    }
    if (/timeout|timed.?out|econnaborted|etimedout/.test(message)) {
        return { code: 'timeout', reason: 'Nhà cung cấp AI không phản hồi trong thời gian cho phép.' };
    }
    if (
        error instanceof SyntaxError ||
        error instanceof z.ZodError ||
        /json|schema|validation|invalid_type|expected/.test(message)
    ) {
        return { code: 'invalid_response', reason: 'Các model AI đã trả kết quả không đúng cấu trúc bản tin.' };
    }
    return { code: 'provider_unavailable', reason: 'Nhà cung cấp AI tạm thời không khả dụng.' };
};

export const generateGroundedBriefingContent = async (
    period: BriefingPeriodRange,
    snapshot: ExecutiveBriefingSnapshot
): Promise<GeneratedBriefingContent> => {
    const deterministic = buildDeterministicBriefingContent(snapshot, period.periodLabel);
    const validEvidence = new Set(snapshot.evidence.map((entry) => entry.key));

    try {
        const response = await aiProviderService.generateJson<AiBriefing>(
            {
                feature: AI_FEATURES.EXECUTIVE_BRIEFING,
                temperature: 0.15,
                reasoningEffort: 'low',
                maxTokens: 2200,
                timeoutMs: 90_000,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: JSON.stringify(buildAiDataset(period, snapshot)) },
                ],
            },
            (data) => {
                const parsed = parseExecutiveBriefingAiResponse(data);
                const usableCount =
                    normalizeItems('highlight', parsed.highlights, validEvidence).length +
                    normalizeItems('risk', parsed.risks, validEvidence).length +
                    normalizeItems('action', parsed.actions, validEvidence).filter((entry) => entry.actionKey).length;
                if (!usableCount) {
                    throw new Error('AI briefing schema: response has no grounded insight items');
                }
                return parsed;
            }
        );
        const parsed = response.data;
        const highlights = normalizeItems('highlight', parsed.highlights, validEvidence).filter((entry) =>
            ['positive', 'info'].includes(entry.severity)
        );
        const risks = normalizeItems('risk', parsed.risks, validEvidence).filter((entry) =>
            ['warning', 'critical'].includes(entry.severity)
        );
        const actions = normalizeItems('action', parsed.actions, validEvidence).filter((entry) => entry.actionKey);

        const mergedHighlights = mergeGroundedItems(highlights, deterministic.highlights, 4);
        const mergedRisks = mergeGroundedItems(risks, deterministic.risks, 5);
        const mergedActions = mergeGroundedItems(actions, deterministic.actions, 4);
        const aiContributionCount = [...mergedHighlights, ...mergedRisks, ...mergedActions].filter((entry) =>
            entry.id.startsWith('ai-')
        ).length;

        return {
            content: {
                // Số liệu và quan hệ giữa các chỉ số luôn do rule backend viết. AI chỉ bổ sung mục có evidence.
                summary: deterministic.summary,
                highlights: mergedHighlights,
                risks: mergedRisks,
                actions: mergedActions,
            },
            generationStatus: 'ready',
            provider: response.provider,
            model: response.model,
            latencyMs: response.latencyMs,
            aiContributionCount,
        };
    } catch (error) {
        const fallback = describeExecutiveBriefingAiFailure(error);
        console.warn(
            `[ExecutiveBriefing] AI không khả dụng (${fallback.code}), dùng nội dung xác định:`,
            error instanceof Error ? error.message : error
        );
        return {
            content: deterministic,
            generationStatus: 'degraded',
            provider: 'fallback',
            fallbackCode: fallback.code,
            fallbackReason: fallback.reason,
        };
    }
};
