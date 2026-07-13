import { z } from 'zod';
import { aiProviderService, type AiChatMessage } from '@/services/ai/ai-provider.service';
import { allowedAssistantTools, type AssistantContext } from '@/services/ai/assistant-policy.service';
import {
    ASSISTANT_TOOL_SCHEMAS,
    compactAssistantToolCatalog,
    validateAssistantToolArgs,
    type AssistantToolName,
} from '@/services/ai/assistant-tool-registry.service';

const rawPlanSchema = z.object({
    goal: z.string().trim().max(500).optional(),
    steps: z
        .array(
            z.object({
                tool: z.string().trim().min(1).max(80),
                args: z.record(z.string(), z.unknown()).default({}),
                purpose: z.string().trim().max(240).optional(),
            })
        )
        .min(1)
        .max(5),
    synthesisGuide: z.string().trim().max(500).optional(),
});

export type AssistantPlanStep = {
    tool: AssistantToolName;
    args: Record<string, any>;
    purpose?: string;
};

export type AssistantPlan = {
    goal?: string;
    steps: AssistantPlanStep[];
    synthesisGuide?: string;
    provider: string;
    model?: string;
};

export const createAssistantPlan = async (params: {
    messages: { role: 'user' | 'assistant'; content: string }[];
    context: AssistantContext;
    feature: string;
    modelOverride?: string;
}): Promise<AssistantPlan> => {
    const allowed = allowedAssistantTools(params.context);
    const catalog = compactAssistantToolCatalog(allowed);
    const messages: AiChatMessage[] = [
        {
            role: 'system',
            content: [
                'Bạn là bộ lập kế hoạch truy vấn dữ liệu cho trợ lý vận hành công ty may.',
                'Chỉ lập kế hoạch, không trả lời câu hỏi và không bịa dữ liệu.',
                'Trả JSON: {"goal":"...","steps":[{"tool":"...","args":{},"purpose":"..."}],"synthesisGuide":"..."}.',
                'Tối đa 5 bước. Mỗi khía cạnh trong câu hỏi phức tạp cần tool phù hợp; không gọi trùng nếu không cần.',
                'Chỉ dùng tool được liệt kê. Ngày tùy chọn dùng startDate/endDate theo YYYY-MM-DD.',
                `Vai trò: ${params.context.role}; cơ sở: ${params.context.plantName || params.context.plantId || 'chưa gán'}.`,
                'TOOL ĐƯỢC PHÉP:',
                catalog,
            ].join('\n'),
        },
        ...params.messages.slice(-8),
    ];

    const generated = await aiProviderService.generateJson<unknown>({
        feature: params.feature,
        model: params.modelOverride,
        temperature: 0,
        maxTokens: 900,
        timeoutMs: 30000,
        reasoningEffort: 'low',
        messages,
    });
    const raw = rawPlanSchema.parse(generated.data);
    const steps: AssistantPlanStep[] = [];

    for (const step of raw.steps) {
        if (!allowed.includes(step.tool) || !(step.tool in ASSISTANT_TOOL_SCHEMAS)) continue;
        const tool = step.tool as AssistantToolName;
        try {
            steps.push({
                tool,
                args: validateAssistantToolArgs(tool, step.args),
                purpose: step.purpose,
            });
        } catch {
            // Bỏ bước sai schema; ReAct loop phía sau vẫn có thể tự sửa bằng tool call khác.
        }
    }

    if (!steps.length) throw new Error('Assistant planner did not produce a valid tool step');
    return {
        goal: raw.goal,
        steps,
        synthesisGuide: raw.synthesisGuide,
        provider: generated.provider,
        model: generated.model,
    };
};
