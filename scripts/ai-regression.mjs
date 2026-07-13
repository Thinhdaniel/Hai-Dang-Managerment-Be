#!/usr/bin/env node
/**
 * Regression test cho TRỢ LÝ VẬN HÀNH (/ai/assistant).
 * Đọc lại bộ câu hỏi từ file report (mặc định bộ 100 câu prod), gọi endpoint thật,
 * chấm tự động (bad/warn/good) + đo độ trễ, ghi report mới. Dùng làm cổng trước khi deploy AI.
 *
 * Cách chạy (PowerShell):
 *   $env:AI_TEST_BASE="https://hai-dang-managerment-be.onrender.com"   # hoặc http://localhost:8000
 *   $env:AI_TEST_EMAIL="hieu707203@gmail.com"; $env:AI_TEST_PASSWORD="..."
 *   node scripts/ai-regression.mjs                  # chạy toàn bộ
 *   node scripts/ai-regression.mjs --limit 20       # chạy 20 câu đầu
 *   node scripts/ai-regression.mjs --max-bad 3      # cho phép tối đa 3 câu bad (exit!=0 nếu vượt)
 *
 * Không cần thư viện ngoài (Node >= 18, dùng fetch sẵn có).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goldenCases } from './ai-golden-cases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const BASE = (process.env.AI_TEST_BASE || 'http://localhost:8000').replace(/\/$/, '');
const EMAIL = process.env.AI_TEST_EMAIL || '';
const PASSWORD = process.env.AI_TEST_PASSWORD || '';
const LIMIT = Number(arg('limit', 0)) || 0;
const MAX_BAD = Number(arg('max-bad', 0)) || 0;
const MAX_P95_MS = Number(arg('max-p95-ms', 45000)) || 45000;
const REPORT_IN = arg('in', '');
const REPORT_OUT = arg(
    'out',
    path.join(REPO_ROOT, 'tmp', `ai-regression-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`)
);

if (!EMAIL || !PASSWORD) {
    console.error('❌ Thiếu AI_TEST_EMAIL / AI_TEST_PASSWORD trong env.');
    process.exit(2);
}

// Mẫu câu trả lời "trượt" (fallback / xin lỗi / generic) -> coi là bad/warn.
const RX_FALLBACK = /^(xin lỗi|mình chưa|mình chưa chắc)/i;
const RX_GENERIC = /(mình (hỗ trợ|tra được)|diễn đạt lại|thử hỏi lại)/i;

const login = async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!r.ok) throw new Error(`Login HTTP ${r.status}`);
    const j = await r.json();
    // access_token nằm ở top-level (login KHÔNG bọc trong "data"); vẫn fallback data.* cho chắc.
    const token = j?.access_token || j?.data?.access_token;
    if (!token) throw new Error('Login không trả access_token');
    return token;
};

const ask = async (token, question) => {
    const t0 = Date.now();
    try {
        const r = await fetch(`${BASE}/api/ai/assistant`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
        });
        const took = Date.now() - t0;
        if (!r.ok) return { httpStatus: r.status, took, error: `HTTP ${r.status}` };
        const j = await r.json();
        const d = j?.data || {};
        return {
            httpStatus: r.status,
            took,
            answer: d.answer || '',
            provider: d.provider,
            model: d.model,
            tier: d.tier,
            confidence: d.confidence,
            grounding: d.grounding,
            count: d.count,
            sources: (d.sources || []).map((s) => s.label),
            reqId: d.reqId,
        };
    } catch (e) {
        return { httpStatus: 0, took: Date.now() - t0, error: String(e?.message || e) };
    }
};

const normalizeText = (value) =>
    String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd');

const grade = (res, expected = {}) => {
    if (res.error || !res.answer) return 'bad';
    if (res.provider === 'fallback' && (!res.sources || !res.sources.length)) return 'bad';
    if (RX_FALLBACK.test(res.answer.trim())) return 'bad';
    const sources = new Set(res.sources || []);
    if ((expected.expectedSources || []).some((source) => !sources.has(source))) return 'bad';
    if ((expected.forbiddenSources || []).some((source) => sources.has(source))) return 'bad';
    const answer = normalizeText(res.answer);
    if ((expected.answerIncludes || []).some((text) => !answer.includes(normalizeText(text)))) return 'bad';
    if ((expected.answerExcludes || []).some((text) => answer.includes(normalizeText(text)))) return 'bad';
    if (
        expected.minConfidence &&
        ['none', 'low', 'medium', 'high'].indexOf(res.confidence) <
            ['none', 'low', 'medium', 'high'].indexOf(expected.minConfidence)
    )
        return 'bad';
    if (expected.requireGrounding && !['verified', 'corrected'].includes(res.grounding)) return 'bad';
    if (RX_GENERIC.test(res.answer)) return 'warn';
    if (res.took > 30000) return 'warn';
    if (!res.count && (!res.sources || !res.sources.length) && res.confidence === 'none') return 'warn';
    return 'good';
};

const pctile = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const main = async () => {
    if (REPORT_IN && !fs.existsSync(REPORT_IN)) {
        console.error(`❌ Không thấy file câu hỏi: ${REPORT_IN}`);
        process.exit(2);
    }
    const sourceCases = REPORT_IN ? JSON.parse(fs.readFileSync(REPORT_IN, 'utf-8')) : goldenCases;
    let questions = sourceCases
        .map((it) => ({
            id: it.id,
            group: it.group,
            question: it.question,
            expectedSources: it.expectedSources,
            forbiddenSources: it.forbiddenSources,
            answerIncludes: it.answerIncludes,
            answerExcludes: it.answerExcludes,
            minConfidence: it.minConfidence,
            requireGrounding: it.requireGrounding,
        }))
        .filter((q) => q.question);
    if (LIMIT) questions = questions.slice(0, LIMIT);

    console.log(`🔎 Regression ${questions.length} câu → ${BASE}`);
    const token = await login();
    console.log('✅ Đăng nhập OK\n');

    const results = [];
    const latencies = [];
    let good = 0,
        warn = 0,
        bad = 0;

    for (const q of questions) {
        const res = await ask(token, q.question);
        const verdict = grade(res, q);
        if (verdict === 'good') good++;
        else if (verdict === 'warn') warn++;
        else bad++;
        latencies.push(res.took);
        results.push({ ...q, verdict, ...res });
        const icon = verdict === 'good' ? '🟢' : verdict === 'warn' ? '🟡' : '🔴';
        console.log(
            `${icon} ${String(q.id).padStart(3)} [${(res.took / 1000).toFixed(1)}s] ${q.question.slice(0, 60)}`
        );
        if (verdict !== 'good') console.log(`     ↳ ${(res.error || res.answer || '').slice(0, 90)}`);
    }

    const summary = {
        base: BASE,
        total: results.length,
        good,
        warn,
        bad,
        latencyMs: {
            avg: Math.round(latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1)),
            p50: pctile(latencies, 50),
            p90: pctile(latencies, 90),
            p95: pctile(latencies, 95),
            max: Math.max(0, ...latencies),
        },
        ranAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify({ summary, results }, null, 2), 'utf-8');

    console.log('\n──────── TỔNG KẾT ────────');
    console.log(`🟢 good ${good}  🟡 warn ${warn}  🔴 bad ${bad}  (/${results.length})`);
    console.log(
        `⏱  avg ${(summary.latencyMs.avg / 1000).toFixed(1)}s · P50 ${(summary.latencyMs.p50 / 1000).toFixed(1)}s · P90 ${(summary.latencyMs.p90 / 1000).toFixed(1)}s · P95 ${(summary.latencyMs.p95 / 1000).toFixed(1)}s`
    );
    console.log(`📄 ${REPORT_OUT}`);

    if (bad > MAX_BAD) {
        console.error(`\n❌ ${bad} câu BAD vượt ngưỡng cho phép (${MAX_BAD}).`);
        process.exit(1);
    }
    if (summary.latencyMs.p95 > MAX_P95_MS) {
        console.error(`\n❌ P95 ${summary.latencyMs.p95}ms vượt ngưỡng ${MAX_P95_MS}ms.`);
        process.exit(1);
    }
    console.log('\n✅ Đạt ngưỡng regression.');
};

main().catch((e) => {
    console.error('❌ Lỗi:', e?.message || e);
    process.exit(2);
});
