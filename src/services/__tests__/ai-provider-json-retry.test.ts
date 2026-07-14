import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import axios from 'axios';
import { z } from 'zod';
import config from '@/config/env.config';
import { aiProviderService } from '@/services/ai/ai-provider.service';

const responseSchema = z.object({ status: z.literal('ready'), summary: z.string().min(10) });

type MutableAiConfig = typeof config.ai;

const withTestAiConfig = (t: TestContext, feature: string, models: string[]) => {
    const ai = config.ai as MutableAiConfig;
    const previous = {
        enabled: ai.enabled,
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        defaultModel: ai.defaultModel,
        jsonModel: ai.jsonModel,
        featureModels: ai.featureModels,
    };

    ai.enabled = true;
    ai.provider = '9router';
    ai.baseUrl = 'http://ai-provider.test/v1';
    ai.apiKey = 'test-key';
    ai.defaultModel = 'test/default';
    ai.jsonModel = 'test/default';
    ai.featureModels = { ...ai.featureModels, [feature]: models };

    t.after(() => {
        Object.assign(ai, previous);
    });
};

test('thử model tiếp theo khi model đầu trả JSON không parse được', async (t) => {
    const feature = 'test-json-parse-retry';
    withTestAiConfig(t, feature, ['test/broken-json', 'test/valid-json']);
    const calls: string[] = [];

    t.mock.method(axios, 'post', async (_url: string, body: { model: string }) => {
        calls.push(body.model);
        const content =
            body.model === 'test/broken-json'
                ? 'not-json'
                : JSON.stringify({ status: 'ready', summary: 'Nội dung hợp lệ từ model dự phòng.' });
        return { data: { model: body.model, choices: [{ message: { content } }] } };
    });

    const result = await aiProviderService.generateJson(
        {
            feature,
            messages: [{ role: 'user', content: 'test' }],
        },
        (data) => responseSchema.parse(data)
    );

    assert.deepEqual(calls, ['test/broken-json', 'test/valid-json']);
    assert.equal(result.model, 'test/valid-json');
    assert.equal(result.data.status, 'ready');
});

test('thử model tiếp theo khi JSON đúng cú pháp nhưng sai schema nghiệp vụ', async (t) => {
    const feature = 'test-json-schema-retry';
    withTestAiConfig(t, feature, ['test/wrong-schema', 'test/valid-schema']);
    const calls: string[] = [];

    t.mock.method(axios, 'post', async (_url: string, body: { model: string }) => {
        calls.push(body.model);
        const payload =
            body.model === 'test/wrong-schema'
                ? { status: 'unknown', summary: 'ngắn' }
                : { status: 'ready', summary: 'Bản tin đã qua kiểm tra schema.' };
        return {
            data: {
                model: body.model,
                choices: [{ message: { content: JSON.stringify(payload) } }],
            },
        };
    });

    const result = await aiProviderService.generateJson(
        {
            feature,
            messages: [{ role: 'user', content: 'test' }],
        },
        (data) => responseSchema.parse(data)
    );

    assert.deepEqual(calls, ['test/wrong-schema', 'test/valid-schema']);
    assert.equal(result.model, 'test/valid-schema');
    assert.match(result.data.summary, /schema/);
});
