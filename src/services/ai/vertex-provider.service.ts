import axios from 'axios';
import config from '@/config/env.config';
import {
    extractJsonObject,
    type AiChatMessage,
    type AiContentPart,
    type AiGenerateTextOptions,
    type AiGenerateTextResult,
} from '@/services/ai/ai-provider.service';

type VertexProxyResponse = {
    content?: string;
    provider?: string;
    model?: string;
    latencyMs?: number;
    error?: string;
    raw?: unknown;
};

const textFromPart = (part: AiContentPart) => (part.type === 'text' ? part.text : '');
const imageFromPart = (part: AiContentPart) => (part.type === 'image_url' ? part.image_url.url : undefined);

const flattenMessages = (messages: AiChatMessage[]) => {
    const system: string[] = [];
    const prompt: string[] = [];
    const images: string[] = [];

    for (const message of messages) {
        if (typeof message.content === 'string') {
            if (message.role === 'system') system.push(message.content);
            else prompt.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
            continue;
        }

        const textParts = message.content.map(textFromPart).filter(Boolean);
        const imageParts = message.content.map(imageFromPart).filter((url): url is string => Boolean(url));
        if (message.role === 'system') system.push(textParts.join('\n'));
        else if (textParts.length) prompt.push(textParts.join('\n'));
        images.push(...imageParts);
    }

    return {
        system: system.filter(Boolean).join('\n\n'),
        prompt: prompt.filter(Boolean).join('\n\n'),
        images,
    };
};

const requireEnabled = () => {
    if (!config.vertex.enabled || !config.vertex.proxyUrl || !config.vertex.proxyKey) {
        throw new Error('Vertex proxy is not configured');
    }
};

export const vertexProviderService = {
    isEnabled: () => config.vertex.enabled,

    async generateText(options: AiGenerateTextOptions): Promise<AiGenerateTextResult> {
        requireEnabled();
        const startedAt = Date.now();
        const body = flattenMessages(options.messages);
        const model = options.model || config.vertex.visionModel;

        const response = await axios.post<VertexProxyResponse>(
            `${config.vertex.proxyUrl}/generate`,
            {
                ...body,
                model,
                temperature: options.temperature ?? 0.2,
                maxOutputTokens: options.maxTokens ?? 4096,
                json: Boolean(options.jsonMode),
                // Chuyển tiếp mức suy luận để proxy tắt "thinking" của Gemini (thinkingBudget) —
                // OCR truyền 'low'/'none' để tránh đốt token khiến JSON bị cắt cụt.
                ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
            },
            {
                timeout: options.timeoutMs ?? config.vertex.timeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'x-vertex-proxy-key': config.vertex.proxyKey,
                },
            }
        );

        const content = response.data.content?.trim();
        if (!content) {
            throw new Error(response.data.error || 'Vertex response is empty');
        }

        return {
            content,
            provider: 'vertex',
            model: response.data.model || model,
            latencyMs: response.data.latencyMs ?? Date.now() - startedAt,
        };
    },

    async generateJson<T>(options: AiGenerateTextOptions): Promise<AiGenerateTextResult & { data: T }> {
        const result = await this.generateText({ ...options, jsonMode: true });
        return {
            ...result,
            data: JSON.parse(extractJsonObject(result.content)) as T,
        };
    },
};
