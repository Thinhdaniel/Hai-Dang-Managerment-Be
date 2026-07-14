const http = require('http');

const PORT = Number(process.env.VERTEX_PORT || 30128);
const PROJECT_ID = process.env.VERTEX_PROJECT_ID;
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const IMAGE_LOCATION = process.env.VERTEX_IMAGE_LOCATION || 'global';
const PROXY_KEY = process.env.VERTEX_PROXY_KEY;
const DEFAULT_MODEL = process.env.VERTEX_MODEL || 'gemini-2.5-flash-lite';
const DEFAULT_IMAGE_MODEL = process.env.VERTEX_IMAGE_MODEL || 'gemini-3.1-flash-image';
const FETCH_TIMEOUT_MS = Number(process.env.VERTEX_FETCH_TIMEOUT_MS || 85000);
const IMAGE_FETCH_TIMEOUT_MS = Number(process.env.VERTEX_IMAGE_FETCH_TIMEOUT_MS || 180000);
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 7 * 1024 * 1024;

const ALLOWED_IMAGE_MODELS = new Set(
    String(process.env.VERTEX_ALLOWED_IMAGE_MODELS || 'gemini-3.1-flash-image,gemini-2.5-flash-image')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
);

const ALLOWED_IMAGE_HOSTS = new Set(
    String(process.env.VERTEX_REFERENCE_IMAGE_HOSTS || 'res.cloudinary.com')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
);

const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif',
]);

const ALLOWED_ASPECT_RATIOS = new Set([
    '1:1',
    '3:2',
    '2:3',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
]);

const ALLOWED_IMAGE_SIZES = new Set(['512', '1K', '2K', '4K']);

const json = (res, status, data) => {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
};

const httpError = (status, message, raw) => {
    const error = new Error(message);
    error.status = status;
    error.raw = raw;
    return error;
};

const readBody = (req) =>
    new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 30 * 1024 * 1024) {
                reject(httpError(413, 'Payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(httpError(400, 'Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });

let cachedToken = null;
let tokenExpiresAt = 0;
const getAccessToken = async () => {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt) return cachedToken;

    const response = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
    );
    if (!response.ok) throw httpError(response.status, `Metadata token failed: ${response.status}`);
    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiresAt = now + Math.max(((data.expires_in || 3600) - 60) * 1000, 0);
    return cachedToken;
};

const dataUrlToInlineData = (url) => {
    const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/s);
    if (!match || !ALLOWED_IMAGE_MIME_TYPES.has(match[1])) return null;
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) {
        throw httpError(400, 'Reference image exceeds the 7 MB inline limit');
    }
    return { inlineData: { mimeType: match[1], data: match[2] } };
};

const isAllowedImageHost = (hostname) => {
    const normalized = String(hostname || '').toLowerCase();
    return [...ALLOWED_IMAGE_HOSTS].some(
        (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`)
    );
};

const fetchReferenceImage = async (source) => {
    let parsed;
    try {
        parsed = new URL(source);
    } catch {
        throw httpError(400, 'Reference image URL is invalid');
    }
    if (parsed.protocol !== 'https:' || !isAllowedImageHost(parsed.hostname)) {
        throw httpError(400, `Reference image host is not allowed: ${parsed.hostname || 'unknown'}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
        response = await fetch(parsed, { redirect: 'follow', signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) throw httpError(400, `Reference image download failed: ${response.status}`);

    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !isAllowedImageHost(finalUrl.hostname)) {
        throw httpError(400, 'Reference image redirected to a disallowed host');
    }

    const mimeType = String(response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        throw httpError(400, `Unsupported reference image type: ${mimeType || 'unknown'}`);
    }

    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_REFERENCE_BYTES) {
        throw httpError(400, 'Reference image exceeds the 7 MB inline limit');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) {
        throw httpError(400, 'Reference image exceeds the 7 MB inline limit');
    }
    return { inlineData: { mimeType, data: bytes.toString('base64') } };
};

const thinkingBudgetFor = (effort) => {
    switch (effort) {
        case 'none':
            return 0;
        case 'low':
            return 512;
        case 'medium':
            return 2048;
        case 'high':
            return 8192;
        default:
            return null;
    }
};

const resolveThinkingConfig = (model, effort) => {
    let budget = thinkingBudgetFor(effort);
    if (budget === null) return null;
    const isPro = String(model).includes('pro');
    if (isPro && budget < 128) budget = 128;
    return { thinkingBudget: budget, includeThoughts: false };
};

const buildTextContents = (body) => {
    if (Array.isArray(body.contents)) return body.contents;

    const parts = [];
    if (body.prompt) parts.push({ text: String(body.prompt) });
    for (const image of body.images || []) {
        const inline = dataUrlToInlineData(image);
        if (inline) parts.push(inline);
    }
    return [{ role: 'user', parts }];
};

const buildImageContents = async (body) => {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw httpError(400, 'Image prompt is required');

    const parts = [{ text: prompt }];
    for (const source of (Array.isArray(body.images) ? body.images : []).slice(0, MAX_REFERENCE_IMAGES)) {
        if (typeof source !== 'string' || !source.trim()) continue;
        const inline = dataUrlToInlineData(source) || (await fetchReferenceImage(source));
        parts.push(inline);
    }
    return [{ role: 'user', parts }];
};

const vertexEndpoint = (location, model) => {
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    return (
        `https://${host}/v1/projects/${PROJECT_ID}/locations/${location}` +
        `/publishers/google/models/${model}:generateContent`
    );
};

const postVertex = async (endpoint, payload, timeoutMs) => {
    if (!PROJECT_ID) throw httpError(500, 'VERTEX_PROJECT_ID is missing');
    const token = await getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    const raw = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = raw?.error?.message || `Vertex failed: ${response.status}`;
        throw httpError(response.status, message, raw);
    }
    return raw;
};

const callVertexText = async (body) => {
    const model = body.model || DEFAULT_MODEL;
    const thinkingConfig = resolveThinkingConfig(model, body.reasoningEffort);
    const payload = {
        contents: buildTextContents(body),
        ...(body.system ? { systemInstruction: { parts: [{ text: String(body.system) }] } } : {}),
        generationConfig: {
            temperature: body.temperature ?? 0.2,
            maxOutputTokens: body.maxOutputTokens ?? body.maxTokens ?? 4096,
            ...(body.json ? { responseMimeType: 'application/json' } : {}),
            ...(thinkingConfig ? { thinkingConfig } : {}),
        },
    };
    const raw = await postVertex(vertexEndpoint(LOCATION, model), payload, FETCH_TIMEOUT_MS);
    const parts = raw?.candidates?.[0]?.content?.parts || [];
    const content = parts
        .map((part) => part.text || '')
        .join('')
        .trim();
    return {
        content,
        model,
        provider: 'vertex',
        finishReason: raw?.candidates?.[0]?.finishReason,
        usageMetadata: raw.usageMetadata,
        raw,
    };
};

const callVertexImage = async (body) => {
    const model = String(body.model || DEFAULT_IMAGE_MODEL);
    if (!ALLOWED_IMAGE_MODELS.has(model)) throw httpError(400, `Image model is not allowed: ${model}`);

    const aspectRatio = ALLOWED_ASPECT_RATIOS.has(body.aspectRatio) ? body.aspectRatio : '16:9';
    const imageSize = ALLOWED_IMAGE_SIZES.has(body.imageSize) ? body.imageSize : '1K';
    const payload = {
        contents: await buildImageContents(body),
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            candidateCount: 1,
            imageConfig: { aspectRatio, imageSize },
        },
    };
    const raw = await postVertex(vertexEndpoint(IMAGE_LOCATION, model), payload, IMAGE_FETCH_TIMEOUT_MS);
    const parts = raw?.candidates?.[0]?.content?.parts || [];
    const images = parts
        .map((part) => part.inlineData || part.inline_data)
        .filter((part) => part?.data)
        .map((part) => ({ base64: part.data, mimeType: part.mimeType || part.mime_type || 'image/png' }));
    if (!images.length) {
        const reason = raw?.promptFeedback?.blockReason || raw?.candidates?.[0]?.finishReason || 'no image returned';
        throw httpError(502, `Vertex image generation failed: ${reason}`);
    }

    return {
        content: parts
            .map((part) => part.text || '')
            .join('')
            .trim(),
        images,
        model,
        provider: 'vertex',
        finishReason: raw?.candidates?.[0]?.finishReason,
        usageMetadata: raw.usageMetadata,
    };
};

const server = http.createServer(async (req, res) => {
    try {
        const path = String(req.url || '').split('?')[0];
        if (req.method === 'GET' && path === '/health') {
            return json(res, 200, {
                ok: true,
                provider: 'vertex',
                projectId: PROJECT_ID,
                location: LOCATION,
                imageLocation: IMAGE_LOCATION,
                imageGeneration: true,
            });
        }

        if (req.method !== 'POST' || !['/generate', '/image/generate'].includes(path)) {
            return json(res, 404, { error: 'Not found' });
        }
        if (!PROXY_KEY || req.headers['x-vertex-proxy-key'] !== PROXY_KEY) {
            return json(res, 401, { error: 'Unauthorized' });
        }

        const body = await readBody(req);
        const startedAt = Date.now();
        const result = path === '/image/generate' ? await callVertexImage(body) : await callVertexText(body);
        return json(res, 200, { ...result, latencyMs: Date.now() - startedAt });
    } catch (error) {
        if (error?.name === 'AbortError') {
            return json(res, 504, { error: 'Vertex request timed out' });
        }
        return json(res, error.status || 500, {
            error: error.message || 'Vertex proxy error',
            ...(error.raw ? { raw: error.raw } : {}),
        });
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(
        `[vertex-proxy] listening on http://127.0.0.1:${PORT} ` +
            `(text=${LOCATION}, image=${IMAGE_LOCATION})`
    );
});
