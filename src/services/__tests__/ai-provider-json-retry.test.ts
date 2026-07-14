import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import axios from 'axios';
import { z } from 'zod';
import config from '@/config/env.config';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { mergeGroundedItems, parseExecutiveBriefingAiResponse } from '@/services/executive-briefing-ai.service';
import type { BriefingContentItem } from '@/types/executiveBriefing';

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
    const responseFormats: unknown[] = [];

    t.mock.method(axios, 'post', async (_url: string, body: { model: string; response_format?: unknown }) => {
        calls.push(body.model);
        responseFormats.push(body.response_format);
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
    assert.deepEqual(responseFormats, [{ type: 'json_object' }, { type: 'json_object' }]);
    assert.equal(result.model, 'test/valid-json');
    assert.equal(result.data.status, 'ready');
});

test('gọi lại cùng model không có response_format khi provider không hỗ trợ', async (t) => {
    const feature = 'test-json-format-compatibility';
    withTestAiConfig(t, feature, ['test/no-response-format']);
    const formats: unknown[] = [];

    t.mock.method(axios, 'post', async (_url: string, body: { model: string; response_format?: unknown }) => {
        formats.push(body.response_format);
        if (body.response_format) {
            throw Object.assign(new Error('response_format is not supported'), {
                isAxiosError: true,
                response: { status: 400, data: { error: { message: 'response_format is not supported' } } },
            });
        }
        return {
            data: {
                model: body.model,
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                status: 'ready',
                                summary: 'Provider vẫn trả JSON hợp lệ bằng prompt.',
                            }),
                        },
                    },
                ],
            },
        };
    });

    const result = await aiProviderService.generateJson(
        { feature, messages: [{ role: 'user', content: 'test' }] },
        (data) => responseSchema.parse(data)
    );

    assert.deepEqual(formats, [{ type: 'json_object' }, undefined]);
    assert.equal(result.model, 'test/no-response-format');
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

test('chuẩn hóa response bản tin bọc trong data, field alias và loại chữ số AI tự viết', () => {
    const parsed = parseExecutiveBriefingAiResponse({
        data: {
            overview: 'Tổng hợp vận hành',
            positiveSignals: [
                {
                    headline: 'Độ phủ QR đạt 88 phần trăm',
                    description: 'Tiến độ gắn tem tăng 12 phần trăm so với kỳ trước.',
                    level: 'success',
                    evidence_keys: ['fleet.qrCoveragePct'],
                },
            ],
            warnings: [null, { title: 'Thiếu dữ liệu' }],
            recommendations: [
                {
                    title: 'Rà soát tem còn thiếu',
                    message: 'Ưu tiên hoàn thiện tem tại các cơ sở có khoảng trống dữ liệu.',
                    priority: 'medium',
                    sources: [{ key: 'fleet.qrCoveragePct' }],
                    action_key: 'qr_gap',
                    action_label: 'Mở danh sách máy',
                },
            ],
        },
    });

    assert.equal(parsed.highlights.length, 1);
    assert.equal(parsed.highlights[0].severity, 'positive');
    assert.equal(/\d/.test(parsed.highlights[0].detail), false);
    assert.equal(parsed.risks.length, 0);
    assert.equal(parsed.actions[0].actionKey, 'qr_gap');
    assert.deepEqual(parsed.actions[0].evidenceKeys, ['fleet.qrCoveragePct']);
});

test('từ chối response bản tin không có insight nào sử dụng được', () => {
    assert.throws(
        () => parseExecutiveBriefingAiResponse({ summary: 'Chỉ có phần tóm tắt, không có insight.' }),
        /no usable insight items/
    );
});

test('giữ ít nhất một insight AI trong nội dung cuối khi AI có bằng chứng hợp lệ', () => {
    const deterministic: BriefingContentItem[] = [
        {
            id: 'rule-one',
            title: 'Cảnh báo theo quy tắc',
            detail: 'Nội dung do backend xác định.',
            severity: 'warning',
            evidenceKeys: ['maintenance.overdue'],
        },
        {
            id: 'rule-two',
            title: 'Tồn kho cần chú ý',
            detail: 'Nội dung do backend xác định.',
            severity: 'warning',
            evidenceKeys: ['materials.lowStock'],
        },
    ];
    const aiItems: BriefingContentItem[] = [
        {
            id: 'ai-risk-1',
            title: 'Ưu tiên phối hợp xử lý liên cơ sở',
            detail: 'Cần thống nhất đầu mối xử lý dựa trên tín hiệu bảo trì.',
            severity: 'warning',
            evidenceKeys: ['maintenance.overdue'],
        },
    ];

    const merged = mergeGroundedItems(aiItems, deterministic, 2);
    assert.equal(merged.length, 2);
    assert.ok(merged.some((item) => item.id.startsWith('ai-')));
});
