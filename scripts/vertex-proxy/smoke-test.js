const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const loadProxyKey = () => {
    if (process.env.VERTEX_PROXY_KEY) return process.env.VERTEX_PROXY_KEY;
    const dumpPath = path.join(os.homedir(), '.pm2', 'dump.pm2');
    const processes = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const processEntry = processes.find((item) => item.name === 'vertex-proxy');
    const savedKey = processEntry?.VERTEX_PROXY_KEY || processEntry?.pm2_env?.VERTEX_PROXY_KEY;
    if (savedKey) return savedKey;

    const processId = processEntry?.pm_id;
    if (!Number.isInteger(processId)) return undefined;
    const activeEnv = execFileSync('pm2', ['env', String(processId)], { encoding: 'utf8' });
    const keyLine = activeEnv.split(/\r?\n/).find((line) => line.startsWith('VERTEX_PROXY_KEY:'));
    return keyLine?.slice('VERTEX_PROXY_KEY:'.length).trim();
};

const run = async () => {
    const key = loadProxyKey();
    if (!key) throw new Error('VERTEX_PROXY_KEY was not found in the environment or PM2 dump');

    const startedAt = Date.now();
    const endpoint = process.env.VERTEX_SMOKE_URL || 'http://127.0.0.1:30128/image/generate';
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-vertex-proxy-key': key,
        },
        body: JSON.stringify({
            prompt:
                'Create a clean realistic documentary photograph of an industrial sewing machine in a modern Vietnamese garment factory. No text, no logo, no watermark.',
            model: process.env.VERTEX_IMAGE_MODEL || 'gemini-3.1-flash-image',
            aspectRatio: '16:9',
            imageSize: '512',
        }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${payload.error || 'Unknown proxy error'}`);

    const first = payload.images?.[0];
    const bytes = first?.base64 ? Buffer.from(first.base64, 'base64').length : 0;
    if (!bytes) throw new Error('Proxy returned no image bytes');

    console.log(
        JSON.stringify(
            {
                ok: true,
                status: response.status,
                endpoint,
                provider: payload.provider,
                model: payload.model,
                mimeType: first.mimeType,
                imageBytes: bytes,
                proxyLatencyMs: payload.latencyMs,
                totalLatencyMs: Date.now() - startedAt,
            },
            null,
            2
        )
    );
};

run().catch((error) => {
    console.error(`[vertex-image-smoke] ${error.message}`);
    process.exitCode = 1;
});
