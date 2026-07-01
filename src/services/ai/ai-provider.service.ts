import axios from 'axios';
import config from '@/config/env.config';
import { STRONG_FALLBACK_MODEL } from '@/constant/aiModels';

export type AiProviderName = 'ollama' | '9router' | 'openrouter' | 'fallback' | 'disabled';

// Nội dung tin nhắn: text thuần (đa số tác vụ) hoặc đa phương thức (text + ảnh) cho vision/OCR.
// Dạng mảng theo chuẩn OpenAI-compatible: [{type:'text',text}, {type:'image_url',image_url:{url}}].
// Chỉ nhánh 9router/openrouter hỗ trợ ảnh; Ollama bỏ qua (OCR luôn đi qua 9router).
export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export type AiChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string | AiContentPart[];
};

export type AiGenerateTextOptions = {
    messages: AiChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    timeoutMs?: number;
    feature?: string;
    // Tắt/giảm "thinking" của model reasoning (vd gemini-2.5-flash nay bật thinking mặc định,
    // đốt hết token budget -> JSON cắt cụt). 'none' = không suy luận nội bộ, dành trọn token cho output.
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
};

export type AiGenerateTextResult = {
    content: string;
    provider: AiProviderName;
    model: string;
    latencyMs: number;
};

type OpenAiCompatibleResponse = {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
    model?: string;
};

type OllamaChatResponse = {
    message?: {
        content?: string;
    };
    model?: string;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const normalizeProvider = (): AiProviderName => {
    if (!config.ai.enabled || config.ai.provider === 'disabled') return 'disabled';
    return config.ai.provider;
};

const toModelList = (value?: string | string[]): string[] =>
    Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];

// Chuỗi model theo tác vụ (ưu tiên giảm dần). Biến thể "<feature>-light|-standard|-heavy|-answer"
// tự suy về feature gốc nếu chưa map riêng.
const resolveFeatureModels = (feature?: string): string[] => {
    if (!feature) return [];
    const map = config.ai.featureModels || {};
    const direct = toModelList(map[feature]);
    if (direct.length) return direct;
    const base = feature.replace(/-(light|standard|heavy|answer)$/, '');
    return base !== feature ? toModelList(map[base]) : [];
};

const getOpenAiCompatibleConfig = (provider: AiProviderName) => {
    if (provider === 'openrouter') {
        return {
            baseUrl: trimTrailingSlash(config.ai.baseUrl || 'https://openrouter.ai/api/v1'),
            apiKey: config.ai.openRouter.apiKey,
            model:
                config.ai.openRouter.defaultModel ||
                config.ai.defaultModel ||
                'nousresearch/hermes-3-llama-3.1-405b:free',
            jsonModel:
                config.ai.openRouter.jsonModel ||
                config.ai.jsonModel ||
                config.ai.openRouter.defaultModel ||
                config.ai.defaultModel ||
                'nousresearch/hermes-3-llama-3.1-405b:free',
            extraHeaders: {
                'HTTP-Referer': config.ai.openRouter.httpReferer,
                'X-Title': config.ai.openRouter.appTitle,
            },
        };
    }

    return {
        baseUrl: trimTrailingSlash(config.ai.baseUrl || 'http://127.0.0.1:20128/v1'),
        apiKey: config.ai.apiKey,
        // Lưới cuối: model MẠNH (không để rơi về model nhỏ/yếu nếu env thiếu).
        model: config.ai.defaultModel || STRONG_FALLBACK_MODEL,
        jsonModel: config.ai.jsonModel || config.ai.defaultModel || STRONG_FALLBACK_MODEL,
        extraHeaders: {},
    };
};

const callOpenAiCompatible = async (
    provider: AiProviderName,
    options: AiGenerateTextOptions
): Promise<AiGenerateTextResult> => {
    const startedAt = Date.now();
    const providerConfig = getOpenAiCompatibleConfig(provider);
    // Model đã được generateText quyết theo chuỗi dự phòng và truyền vào options.model.
    const model = options.model || (options.jsonMode ? providerConfig.jsonModel : providerConfig.model);

    const response = await axios.post<OpenAiCompatibleResponse>(
        `${providerConfig.baseUrl}/chat/completions`,
        {
            model,
            messages: options.messages,
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 900,
            stream: false,
            ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        },
        {
            timeout: options.timeoutMs ?? config.ai.timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                ...(providerConfig.apiKey ? { Authorization: `Bearer ${providerConfig.apiKey}` } : {}),
                ...providerConfig.extraHeaders,
            },
        }
    );

    const content = response.data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
        throw new Error(`${provider} response is empty`);
    }

    return {
        content,
        provider,
        model: response.data.model || model,
        latencyMs: Date.now() - startedAt,
    };
};

const callOllama = async (options: AiGenerateTextOptions): Promise<AiGenerateTextResult> => {
    const startedAt = Date.now();
    const model = options.model || (options.jsonMode ? config.ai.ollama.searchModel : config.ai.ollama.defaultModel);

    const response = await axios.post<OllamaChatResponse>(
        `${trimTrailingSlash(config.ai.ollama.baseUrl)}/api/chat`,
        {
            model,
            stream: false,
            ...(options.jsonMode ? { format: 'json' } : {}),
            messages: options.messages,
            options: {
                temperature: options.temperature ?? 0.2,
                top_p: 0.85,
                num_predict: options.maxTokens ?? 900,
            },
        },
        {
            timeout:
                options.timeoutMs ??
                (options.jsonMode ? config.ai.ollama.searchTimeoutMs : config.ai.ollama.timeoutMs) ??
                config.ai.timeoutMs,
        }
    );

    const content = response.data?.message?.content?.trim();
    if (!content) {
        throw new Error('Ollama response is empty');
    }

    return {
        content,
        provider: 'ollama',
        model: response.data.model || model,
        latencyMs: Date.now() - startedAt,
    };
};

export const extractJsonObject = (content: string) => {
    // Gỡ khối suy luận <thinking>...</thinking> mà model "thinking" chèn trước JSON (tránh phá parse).
    const trimmed = content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

    return trimmed;
};

// Dựng chuỗi model sẽ thử theo thứ tự: model truyền tay > chuỗi theo tác vụ > model nền của provider.
const buildModelChain = (provider: AiProviderName, options: AiGenerateTextOptions): string[] => {
    if (options.model) return [options.model];
    const chain = [...resolveFeatureModels(options.feature)];
    let providerFallback: string;
    if (provider === 'ollama') {
        providerFallback = options.jsonMode ? config.ai.ollama.searchModel : config.ai.ollama.defaultModel;
    } else {
        const providerConfig = getOpenAiCompatibleConfig(provider);
        providerFallback = options.jsonMode ? providerConfig.jsonModel : providerConfig.model;
    }
    if (providerFallback && !chain.includes(providerFallback)) chain.push(providerFallback);
    return chain.length ? chain : [providerFallback];
};

export const aiProviderService = {
    async generateText(options: AiGenerateTextOptions): Promise<AiGenerateTextResult> {
        const provider = normalizeProvider();
        if (provider === 'disabled') {
            throw new Error('AI provider is disabled');
        }
        // Gọi lần lượt theo chuỗi dự phòng; model lỗi/không khả dụng thì tự rớt sang model kế tiếp.
        const chain = buildModelChain(provider, options);
        let lastError: unknown;
        for (let i = 0; i < chain.length; i += 1) {
            const model = chain[i];
            try {
                return provider === 'ollama'
                    ? await callOllama({ ...options, model })
                    : await callOpenAiCompatible(provider, { ...options, model });
            } catch (error) {
                lastError = error;
                if (i < chain.length - 1) {
                    const reason = error instanceof Error ? error.message : String(error);
                    console.warn(
                        `[AI] model "${model}"${options.feature ? ` (${options.feature})` : ''} lỗi: ${reason} — thử model dự phòng "${chain[i + 1]}"...`
                    );
                }
            }
        }
        throw lastError ?? new Error('AI provider failed');
    },

    async generateJson<T>(options: AiGenerateTextOptions): Promise<AiGenerateTextResult & { data: T }> {
        const result = await this.generateText({ ...options, jsonMode: true });
        return {
            ...result,
            data: JSON.parse(extractJsonObject(result.content)) as T,
        };
    },
};
