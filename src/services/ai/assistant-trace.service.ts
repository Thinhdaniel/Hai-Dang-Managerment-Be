import { createHash } from 'node:crypto';
import AiAssistantTrace from '@/models/AiAssistantTrace';
import type { AssistantContext } from '@/services/ai/assistant-policy.service';
import type { AssistantGroundingStatus } from '@/services/ai/assistant-grounding.service';
import type { AssistantToolName } from '@/services/ai/assistant-tool-registry.service';

export const ASSISTANT_PROMPT_VERSION = 'assistant-v4.1-borrowing';
export const ASSISTANT_TOOL_REGISTRY_VERSION = '2026-08-31-borrowing-insight';

export type AssistantToolTraceInput = {
    tool: AssistantToolName;
    phase: 'forced' | 'planner' | 'react' | 'fallback';
    args: unknown;
    success: boolean;
    durationMs: number;
    records?: number;
    scope?: string;
    errorCode?: string;
    errorMessage?: string;
};

export type AssistantPlannerTraceInput = {
    used: boolean;
    durationMs: number;
    provider?: string;
    model?: string;
    goal?: string;
    steps?: Array<{ tool: string; purpose?: string }>;
    error?: string;
};

const SECRET_KEY_PATTERN = /(password|passcode|mat\s*khau|mật\s*khẩu|token|api[-_ ]?key|secret|authorization)/i;

export const redactAssistantText = (value: unknown, maxLength = 4000) => {
    let text = String(value ?? '');
    text = text
        .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT_REDACTED]')
        .replace(/\b\d{7,12}:[A-Za-z0-9_-]{20,}\b/g, '[BOT_TOKEN_REDACTED]')
        .replace(/\b(?:sk|key|api)[-_][A-Za-z0-9_-]{16,}\b/gi, '[API_KEY_REDACTED]')
        .replace(
            /((?:password|passcode|mat\s*khau|mật\s*khẩu|token|api[-_ ]?key|secret)\s*[:=]\s*)[^\s,;]+/gi,
            '$1[REDACTED]'
        )
        .replace(/\b([A-Z0-9._%+-]{1,3})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '$1***$2');
    return text.slice(0, maxLength);
};

const sanitizeTraceValue = (value: unknown, depth = 0): unknown => {
    if (depth > 4) return '[TRUNCATED]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactAssistantText(value, 500);
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeTraceValue(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 200);
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .slice(0, 40)
            .map(([key, item]) => [
                key,
                SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeTraceValue(item, depth + 1),
            ])
    );
};

const fingerprint = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');

export const saveAssistantTrace = async (input: {
    reqId: string;
    parentReqId?: string;
    question: string;
    answer: string;
    context: AssistantContext;
    status: 'success' | 'policy' | 'fallback' | 'error';
    tier: 'light' | 'standard' | 'heavy';
    provider: string;
    model?: string;
    confidence: 'high' | 'medium' | 'low' | 'none';
    grounding: AssistantGroundingStatus;
    groundingIssueCount?: number;
    sources: unknown[];
    planner: AssistantPlannerTraceInput;
    tools: AssistantToolTraceInput[];
    actions?: Array<{ type: string; targetPath: string; warnings?: unknown[] }>;
    tookMs: number;
}) => {
    if (!input.context.userId) return;
    const question = redactAssistantText(input.question, 2000);
    const answerPreview = redactAssistantText(input.answer, 4000);
    await AiAssistantTrace.create({
        reqId: input.reqId,
        parentReqId: input.parentReqId,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        toolRegistryVersion: ASSISTANT_TOOL_REGISTRY_VERSION,
        userId: input.context.userId,
        role: input.context.role,
        plantId: input.context.plantId || undefined,
        plantName: redactAssistantText(input.context.plantName, 180),
        canAccessProcurement: input.context.canAccessProcurement,
        question,
        questionFingerprint: fingerprint(question),
        answerPreview,
        answerFingerprint: fingerprint(answerPreview),
        status: input.status,
        tier: input.tier,
        provider: input.provider,
        model: input.model,
        confidence: input.confidence,
        grounding: input.grounding,
        groundingIssueCount: input.groundingIssueCount || 0,
        sourceCount: input.sources.length,
        sources: sanitizeTraceValue(input.sources) as any[],
        planner: sanitizeTraceValue(input.planner) as any,
        tools: input.tools.map((tool) => ({
            ...tool,
            args: sanitizeTraceValue(tool.args),
            scope: tool.scope ? redactAssistantText(tool.scope, 300) : undefined,
            errorMessage: tool.errorMessage ? redactAssistantText(tool.errorMessage, 500) : undefined,
        })),
        toolCallCount: input.tools.length,
        failedToolCount: input.tools.filter((tool) => !tool.success).length,
        actionCount: input.actions?.length || 0,
        actionTypes: [...new Set((input.actions || []).map((action) => String(action.type)).filter(Boolean))],
        tookMs: input.tookMs,
    });
};
