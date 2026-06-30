import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import Material from '@/models/Material';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { AI_FEATURES } from '@/constant/aiModels';
import { MATERIAL_COST_TYPE } from '@/constant/materialCostType';
import customResponse from '@/utils/response';

const COST_TYPE_SET = new Set<string>(Object.values(MATERIAL_COST_TYPE));
const CHUNK_SIZE = 80;

const aiItemSchema = z.object({
    i: z.number(),
    t: z.string(),
    c: z.number().nullish(),
});
const aiRespSchema = z.object({ items: z.array(aiItemSchema).default([]) }).passthrough();

type MaterialLite = { _id: unknown; name?: string; code?: string; category?: string; unit?: string; costType?: string };

const buildSystemPrompt = () =>
    [
        'Ban phan loai vat tu/may cua cong ty may vao DUNG 1 trong 4 nhom (theo BAN CHAT CHI PHI):',
        `"${MATERIAL_COST_TYPE.CONSUMABLE}" = vat tu TIEU HAO, dung het: chi, kim may, dau may, nhan mac, bang keo, phan ve, thoi chi...`,
        `"${MATERIAL_COST_TYPE.SPARE_PART}" = LINH KIEN THAY THE / phu tung sua may: o, day curoa, motor, bo mach, banh rang, chan vit, thoi (suot)...`,
        `"${MATERIAL_COST_TYPE.TOOL}" = CONG CU DUNG CU tai su dung nhieu lan: keo, ga, khuon, duong, kep, thuoc...`,
        `"${MATERIAL_COST_TYPE.ASSET}" = MAY MOC / thiet bi lon: may may, may cat, may thua khuy, may vat so, may tran, ban hut, noi hoi...`,
        'Voi moi dong (dung so thu tu i da cho), chon nhom phu hop nhat. Neu khong chac, van chon nhom hop ly nhat va de c thap.',
        'Tra ve DUY NHAT JSON: {"items":[{"i":number,"t":"consumable|spare_part|tool|asset","c":0..1}]}. Khong giai thich, khong markdown.',
    ].join('\n');

const classifyChunk = async (chunk: MaterialLite[]) => {
    const list = chunk
        .map(
            (m, idx) =>
                `${idx}. ${m.name ?? ''}${m.category ? ` | nhom: ${m.category}` : ''}${m.unit ? ` | dvt: ${m.unit}` : ''}`
        )
        .join('\n');
    const ai = await aiProviderService.generateJson<Record<string, unknown>>({
        feature: AI_FEATURES.MATERIAL_COST_TYPE,
        temperature: 0.1,
        maxTokens: 1800,
        messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: `Phan loai ${chunk.length} muc sau:\n${list}` },
        ],
    });
    const parsed = aiRespSchema.parse(ai.data);
    const byIndex = new Map<number, { t: string; c?: number }>();
    parsed.items.forEach((it) => byIndex.set(it.i, { t: it.t, c: it.c ?? undefined }));
    return { byIndex, provider: ai.provider, model: ai.model };
};

// AI gợi ý phân loại chi phí cho danh mục (không lưu — chỉ trả đề xuất để người rà).
export const suggestMaterialCostTypes = async (req: Request, res: Response) => {
    const onlyUnclassified = String(req.query.onlyUnclassified ?? '') === 'true';
    const filter: Record<string, unknown> = { isDeleted: { $ne: true }, isActive: { $ne: false } };
    if (onlyUnclassified) {
        filter.$or = [{ costType: { $exists: false } }, { costType: null }, { costType: '' }];
    }
    const materials = (await Material.find(filter)
        .select('_id name code category unit costType')
        .sort({ name: 1 })
        .lean()) as MaterialLite[];

    const items: Array<Record<string, unknown>> = [];
    let provider: string | undefined;
    let model: string | undefined;

    for (let start = 0; start < materials.length; start += CHUNK_SIZE) {
        const chunk = materials.slice(start, start + CHUNK_SIZE);
        let byIndex = new Map<number, { t: string; c?: number }>();
        try {
            const r = await classifyChunk(chunk);
            byIndex = r.byIndex;
            provider = r.provider;
            model = r.model;
        } catch {
            // Chunk lỗi -> để trống đề xuất cho các dòng trong chunk (người tự chọn).
        }
        chunk.forEach((m, idx) => {
            const got = byIndex.get(idx);
            const suggested = got && COST_TYPE_SET.has(got.t) ? got.t : undefined;
            items.push({
                id: String(m._id),
                name: m.name,
                code: m.code,
                category: m.category,
                unit: m.unit,
                currentCostType: m.costType || undefined,
                suggestedCostType: suggested,
                confidence: got?.c,
            });
        });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { total: items.length, items, provider, model },
            message: 'AI đã đề xuất phân loại chi phí',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const saveSchema = z.object({
    items: z.array(z.object({ id: z.string().min(1), costType: z.string().nullish() })).default([]),
});

// Lưu phân loại chi phí hàng loạt (sau khi người dùng rà/sửa đề xuất của AI).
export const saveMaterialCostTypes = async (req: Request, res: Response) => {
    const body = saveSchema.parse(req.body);
    const ops = body.items.map((it) => {
        const valid = it.costType && COST_TYPE_SET.has(it.costType) ? it.costType : null;
        return {
            updateOne: {
                filter: { _id: it.id },
                update: valid
                    ? { $set: { costType: valid, updatedBy: req.userId } }
                    : { $unset: { costType: '' }, $set: { updatedBy: req.userId } },
            },
        };
    });
    if (ops.length) await Material.bulkWrite(ops as never[]);
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { updated: ops.length },
            message: 'Đã lưu phân loại chi phí',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
