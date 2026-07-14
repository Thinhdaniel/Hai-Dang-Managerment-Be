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

const aiBriefingSchema = z.object({
    summary: z.string().trim().min(40).max(1200),
    highlights: z.array(aiItemSchema).max(4).default([]),
    risks: z.array(aiItemSchema).max(5).default([]),
    actions: z.array(aiItemSchema).max(4).default([]),
});

type AiBriefing = z.infer<typeof aiBriefingSchema>;

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
        .filter(
            (row) =>
                !containsNumericClaim(row.title) &&
                !containsNumericClaim(row.detail) &&
                row.evidenceKeys.every((key) => validEvidence.has(key))
        )
        .map((row, index) => ({
            id: `ai-${kind}-${index + 1}`,
            title: row.title,
            detail: row.detail,
            severity: row.severity,
            evidenceKeys: [...new Set(row.evidenceKeys)],
            actionKey: row.actionKey as BriefingActionKey | undefined,
            actionLabel: row.actionLabel,
            actionUrl: row.actionKey ? actionUrlFor(row.actionKey as BriefingActionKey) : undefined,
        }));

const mergeGroundedItems = (aiItems: BriefingContentItem[], deterministic: BriefingContentItem[], limit: number) => {
    const covered = new Set(deterministic.flatMap((entry) => entry.evidenceKeys));
    const additions = aiItems.filter((entry) => !entry.evidenceKeys.some((key) => covered.has(key)));
    return [...deterministic, ...additions].slice(0, limit);
};

export type GeneratedBriefingContent = {
    content: ExecutiveBriefingContent;
    generationStatus: 'ready' | 'degraded';
    provider: string;
    model?: string;
    latencyMs?: number;
    fallbackCode?: BriefingFallbackCode;
    fallbackReason?: string;
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
            (data) => aiBriefingSchema.parse(data)
        );
        const parsed = response.data;
        const highlights = normalizeItems('highlight', parsed.highlights, validEvidence).filter((entry) =>
            ['positive', 'info'].includes(entry.severity)
        );
        const risks = normalizeItems('risk', parsed.risks, validEvidence).filter((entry) =>
            ['warning', 'critical'].includes(entry.severity)
        );
        const actions = normalizeItems('action', parsed.actions, validEvidence).filter((entry) => entry.actionKey);

        return {
            content: {
                // Số liệu và quan hệ giữa các chỉ số luôn do rule backend viết. AI chỉ bổ sung mục có evidence.
                summary: deterministic.summary,
                highlights: mergeGroundedItems(highlights, deterministic.highlights, 4),
                risks: mergeGroundedItems(risks, deterministic.risks, 5),
                actions: mergeGroundedItems(actions, deterministic.actions, 4),
            },
            generationStatus: 'ready',
            provider: response.provider,
            model: response.model,
            latencyMs: response.latencyMs,
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
