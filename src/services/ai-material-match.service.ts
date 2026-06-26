import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import Material from '@/models/Material';
import customResponse from '@/utils/response';
import { normalizeMaterialLookupText } from '@/services/material-match.helpers';
import { aiProviderService } from '@/services/ai/ai-provider.service';

type MaterialMatchRequestItem = {
    key: string;
    materialName: string;
    unit?: string;
    note?: string;
};

type MaterialCandidate = {
    id: string;
    code: string;
    name: string;
    unit: string;
    category?: string;
    score: number;
};

type SanitizedMaterialMatch = {
    key: string;
    status: 'matched' | 'suggested' | 'ambiguous' | 'unmatched';
    materialId?: string;
    confidence: number;
    reason: string;
    warnings: string[];
    candidate?: MaterialCandidate;
    candidates: MaterialCandidate[];
};

const aiMatchSchema = z.object({
    matches: z.array(
        z.object({
            key: z.string(),
            status: z.enum(['matched', 'suggested', 'ambiguous', 'unmatched']),
            matchedMaterialId: z.string().nullable().optional(),
            confidence: z.number().min(0).max(100).optional(),
            reason: z.string().max(500).optional(),
            warnings: z.array(z.string().max(300)).optional(),
        })
    ),
});

const compactLookupText = (value?: unknown) => normalizeMaterialLookupText(value).replace(/\s+/g, '');

const clampConfidence = (value?: number) => Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));

// Token quá phổ biến trong ngành may -> không phân biệt được vật tư, bỏ qua khi tính trùng từ.
const STOPWORDS = new Set([
    'may',
    'cai',
    'chiec',
    'bo',
    'loai',
    'dung',
    'cho',
    'va',
    'voi',
    'kim',
    'co',
    'cong',
    'nghiep',
    'mm',
    'cm',
]);

// Lấy token "có nghĩa": bỏ stopword + số ngắn (1,2,18) nhưng GIỮ mã số dài (46003, 502001021).
const meaningfulTokens = (value?: unknown): string[] =>
    normalizeMaterialLookupText(value)
        .split(' ')
        .filter((t) => {
            if (!t || STOPWORDS.has(t)) return false;
            if (/^\d+$/.test(t)) return t.length >= 3;
            return t.length >= 2;
        });

// IDF: từ hiếm (nguyet, vat, curoa, 46003...) -> trọng số cao; từ phổ biến -> thấp.
// Nhờ vậy khớp theo từ ĐẶC TRƯNG thay vì đếm token đều nhau (vd "vit" trùng "vit/vit" bị thổi điểm).
const buildIdf = (materials: any[]) => {
    const total = Math.max(1, materials.length);
    const df = new Map<string, number>();
    materials.forEach((m) => {
        const seen = new Set(
            meaningfulTokens([m.code, m.name, m.unit, m.category, m.description].filter(Boolean).join(' '))
        );
        seen.forEach((t) => df.set(t, (df.get(t) ?? 0) + 1));
    });
    return (token: string) => Math.log((total + 1) / ((df.get(token) ?? 0) + 1)) + 1;
};

type IdfFn = (token: string) => number;

const materialId = (value: unknown) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        const maybeObject = value as any;
        if (typeof maybeObject.toHexString === 'function') return maybeObject.toHexString();
        if (maybeObject._id) return materialId(maybeObject._id);
        if (maybeObject.id) return String(maybeObject.id);
    }
    return String(value);
};

const scoreCandidate = (material: any, item: MaterialMatchRequestItem, idf: IdfFn) => {
    const query = normalizeMaterialLookupText(item.materialName);
    const queryCompact = compactLookupText(item.materialName);
    const unit = normalizeMaterialLookupText(item.unit);
    const code = normalizeMaterialLookupText(material.code);
    const codeCompact = compactLookupText(material.code);
    const name = normalizeMaterialLookupText(material.name);
    const nameCompact = compactLookupText(material.name);
    const materialUnit = normalizeMaterialLookupText(material.unit);
    const text = normalizeMaterialLookupText(
        [material.code, material.name, material.unit, material.category, material.description].filter(Boolean).join(' ')
    );

    if (!query) return 0;

    let score = 0;
    if (code && (code === query || codeCompact === queryCompact)) score += 100;
    else if (code && (code.startsWith(query) || codeCompact.startsWith(queryCompact))) score += 88;

    if (name === query || nameCompact === queryCompact) score += 94;
    else if (name.startsWith(query)) score += 78;
    else if (name.includes(query) || query.includes(name)) score += 64;

    // Trùng từ có TRỌNG SỐ IDF: ưu tiên từ đặc trưng, không thổi điểm vì vài từ phổ biến.
    const queryTokens = meaningfulTokens(item.materialName);
    if (queryTokens.length) {
        let totalWeight = 0;
        let matchedWeight = 0;
        let matchedCount = 0;
        for (const token of queryTokens) {
            const w = idf(token);
            totalWeight += w;
            if (text.includes(token)) {
                matchedWeight += w;
                matchedCount += 1;
            }
        }
        const ratio = totalWeight ? matchedWeight / totalWeight : 0;
        score += Math.round(ratio * 52);
        if (matchedCount === queryTokens.length) score += 14; // khớp đủ token đặc trưng
    }

    if (unit && materialUnit === unit) score += 10;

    return Math.min(100, score);
};

const toCandidate = (material: any, score: number): MaterialCandidate => ({
    id: materialId(material._id),
    code: String(material.code ?? ''),
    name: String(material.name ?? ''),
    unit: String(material.unit ?? ''),
    category: material.category ? String(material.category) : undefined,
    score,
});

const getCandidates = (materials: any[], item: MaterialMatchRequestItem, idf: IdfFn) => {
    const scored = materials
        .map((material) => ({ material, score: scoreCandidate(material, item, idf) }))
        .filter((entry) => entry.score >= 30)
        .sort(
            (a, b) =>
                b.score - a.score || String(a.material.name ?? '').localeCompare(String(b.material.name ?? ''), 'vi')
        )
        .slice(0, 6);

    return scored.map((entry) => toCandidate(entry.material, entry.score));
};

const fallbackMatch = (item: MaterialMatchRequestItem, candidates: MaterialCandidate[]): SanitizedMaterialMatch => {
    const best = candidates[0];
    if (!best) {
        return {
            key: item.key,
            status: 'unmatched',
            confidence: 0,
            reason: 'Không tìm thấy ứng viên đủ gần trong danh mục vật tư.',
            warnings: ['Có thể đây là vật tư mới hoặc tên nhập chưa đủ rõ.'],
            candidates,
        };
    }

    const secondScore = candidates[1]?.score ?? 0;
    const strong = best.score >= 96 && best.score - secondScore >= 12;
    const status = strong ? 'matched' : best.score >= 72 ? 'suggested' : 'ambiguous';

    return {
        key: item.key,
        status,
        materialId: best.id,
        confidence: strong ? 96 : best.score,
        reason: strong
            ? 'Khớp mạnh theo mã/tên/đơn vị trong danh mục.'
            : 'Có ứng viên gần đúng nhưng cần người dùng xác nhận.',
        warnings: status === 'matched' ? [] : ['Không tự áp dụng vì độ chắc chắn chưa đủ cao.'],
        candidate: best,
        candidates,
    };
};

const buildAiPrompt = (items: Array<MaterialMatchRequestItem & { candidates: MaterialCandidate[] }>) =>
    [
        'Nhiem vu: chon vat tu dung nhat trong catalog cho tung dong de xuat mua vat tu.',
        'Chi tra ve JSON hop le, khong markdown, khong giai thich ngoai JSON.',
        'Tuyet doi khong tao materialId moi. matchedMaterialId chi duoc la id co trong candidates cua dong do.',
        'Neu khong du chac chan thi status = "suggested" hoac "ambiguous", khong ep matched.',
        'Quy tac status:',
        '- matched: confidence >= 92, ten/ma/don vi khop ro.',
        '- suggested: confidence 70-91, kha gan nhung can xac nhan.',
        '- ambiguous: nhieu ung vien gan nhau hoac don vi khong ro.',
        '- unmatched: khong ung vien nao hop ly.',
        'Output schema:',
        '{"matches":[{"key":"row-key","status":"matched|suggested|ambiguous|unmatched","matchedMaterialId":"id-or-null","confidence":0,"reason":"ly do ngan","warnings":["canh bao neu co"]}]}',
        'Du lieu can xu ly:',
        JSON.stringify(
            items.map((item) => ({
                key: item.key,
                input: {
                    materialName: item.materialName,
                    unit: item.unit ?? '',
                    note: item.note ?? '',
                },
                candidates: item.candidates.map((candidate) => ({
                    id: candidate.id,
                    code: candidate.code,
                    name: candidate.name,
                    unit: candidate.unit,
                    category: candidate.category ?? '',
                    score: candidate.score,
                })),
            }))
        ),
    ].join('\n');

const sanitizeAiMatches = (
    items: Array<MaterialMatchRequestItem & { candidates: MaterialCandidate[] }>,
    rawMatches: unknown
) => {
    const parsed = aiMatchSchema.parse(rawMatches);
    const rawByKey = new Map(parsed.matches.map((match) => [match.key, match]));

    return items.map((item) => {
        const raw = rawByKey.get(item.key);
        if (!raw) return fallbackMatch(item, item.candidates);

        const candidateById = new Map(item.candidates.map((candidate) => [candidate.id, candidate]));
        const matchedId = raw.matchedMaterialId ? String(raw.matchedMaterialId) : undefined;
        const candidate = matchedId ? candidateById.get(matchedId) : undefined;

        if (!candidate && raw.status !== 'unmatched') {
            const fallback = fallbackMatch(item, item.candidates);
            return {
                ...fallback,
                warnings: [...fallback.warnings, 'AI trả ứng viên ngoài danh sách nên hệ thống đã bỏ qua.'],
            };
        }

        const confidence = clampConfidence(raw.confidence);
        const status =
            raw.status === 'matched' && confidence < 92
                ? 'suggested'
                : raw.status === 'unmatched'
                  ? 'unmatched'
                  : raw.status;

        return {
            key: item.key,
            status,
            materialId: candidate?.id,
            confidence,
            reason: raw.reason?.trim() || 'AI đã so khớp theo tên, mã, đơn vị và nhóm vật tư.',
            warnings: raw.warnings ?? [],
            candidate,
            candidates: item.candidates,
        } satisfies SanitizedMaterialMatch;
    });
};

export const matchMaterialsByAi = async (req: Request, res: Response) => {
    const items = (req.body.items ?? []) as MaterialMatchRequestItem[];
    const materials = await Material.find({ isDeleted: { $ne: true }, isActive: { $ne: false } })
        .select('_id code name unit category description trackInventory isActive')
        .lean();

    // IDF tính 1 lần trên toàn danh mục để chấm điểm theo độ hiếm của từ.
    const idf = buildIdf(materials);

    const rowsWithCandidates = items.map((item) => ({
        ...item,
        materialName: item.materialName.trim(),
        unit: item.unit?.trim(),
        note: item.note?.trim(),
        candidates: getCandidates(materials, item, idf),
    }));

    const rowsNeedingAi = rowsWithCandidates.filter((item) => item.materialName && item.candidates.length > 0);
    const fallbackRows = rowsWithCandidates.filter((item) => !item.materialName || item.candidates.length === 0);

    try {
        const aiResult = rowsNeedingAi.length
            ? await aiProviderService.generateJson<{ matches: unknown[] }>({
                  feature: 'material-match',
                  temperature: 0.05,
                  maxTokens: Math.min(1600, 300 + rowsNeedingAi.length * 180),
                  messages: [
                      {
                          role: 'system',
                          content:
                              'Ban la bo tro so khop danh muc vat tu cho cong ty may. Chi chon trong candidates, uu tien an toan du lieu.',
                      },
                      { role: 'user', content: buildAiPrompt(rowsNeedingAi) },
                  ],
              })
            : null;

        const aiMatches = aiResult ? sanitizeAiMatches(rowsNeedingAi, aiResult.data) : [];
        const fallbackMatches = fallbackRows.map((item) => fallbackMatch(item, item.candidates));
        const resultByKey = new Map([...aiMatches, ...fallbackMatches].map((item) => [item.key, item]));

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    items: rowsWithCandidates.map(
                        (item) => resultByKey.get(item.key) ?? fallbackMatch(item, item.candidates)
                    ),
                    provider: aiResult?.provider ?? 'fallback',
                    model: aiResult?.model,
                    available: Boolean(aiResult),
                    usedFallback: !aiResult,
                    latencyMs: aiResult?.latencyMs,
                },
                message: 'Da goi y khop danh muc vat tu',
                status: StatusCodes.OK,
                success: true,
            })
        );
    } catch {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    items: rowsWithCandidates.map((item) => fallbackMatch(item, item.candidates)),
                    provider: 'fallback',
                    model: undefined,
                    available: false,
                    usedFallback: true,
                },
                message: 'AI khong kha dung, da goi y bang bo so khop noi bo',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }
};
