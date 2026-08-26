import Asset from '@/models/Asset';
import Brand from '@/models/Brand';
import Counter from '@/models/Counter';
import MachineTypeCode from '@/models/MachineTypeCode';
import { BadRequestError } from '@/errors/customError';
import { AI_FEATURES } from '@/constant/aiModels';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import customResponse from '@/utils/response';
import { z } from 'zod';
import {
    ASSET_ORIGIN_CODE,
    DEFAULT_ORIGIN_CODE,
    buildMachineCodePrefix,
    normalizeForCode,
    normalizeTypeKey,
    padSequence,
    suggestTypeCode,
} from '@/constant/machineCode';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

// ===== Helpers (dùng chung cho tạo máy / import / chuẩn hoá) =====

const originCodeOf = (ownershipType?: string) => ASSET_ORIGIN_CODE[String(ownershipType ?? '')] || DEFAULT_ORIGIN_CODE;

/** Mã loại đã lưu cho 1 loại máy (null nếu chưa có). */
export const lookupTypeCode = async (type?: string): Promise<string | null> => {
    const typeKey = normalizeTypeKey(type);
    if (!typeKey) return null;
    const doc = await MachineTypeCode.findOne({ typeKey }).lean();
    return doc?.code ?? null;
};

/**
 * Lấy mã loại theo thứ tự ưu tiên: mã người dùng nhập (override) > mã đã lưu > gợi ý tự động.
 * Ưu tiên override để người dùng sửa được mã đã lưu sai trước đây.
 */
export const resolveTypeCode = async (type?: string, override?: string) => {
    const overrideCode = normalizeForCode(override);
    const saved = await lookupTypeCode(type);
    if (overrideCode) return { code: overrideCode, isNew: overrideCode !== saved };
    if (saved) return { code: saved, isNew: false };
    return { code: suggestTypeCode(type), isNew: true };
};

/** Ghi nhớ mã loại. forceUpdate=true (người dùng nhập tay) thì ghi đè mã đã lưu; mặc định chỉ lưu lần đầu. */
export const ensureTypeCode = async (type: string | undefined, code: string, forceUpdate = false) => {
    const typeKey = normalizeTypeKey(type);
    const normalizedCode = normalizeForCode(code);
    if (!typeKey || !normalizedCode) return;
    const label = String(type ?? '').trim();
    await MachineTypeCode.updateOne(
        { typeKey },
        forceUpdate
            ? { $set: { code: normalizedCode, label }, $setOnInsert: { typeKey } }
            : { $setOnInsert: { typeKey, code: normalizedCode, label } },
        { upsert: true }
    );
};

const nextSequence = async (prefix: string) => {
    const doc = await Counter.findOneAndUpdate(
        { key: prefix },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
    );
    return doc?.seq ?? 1;
};

const peekSequence = async (prefix: string) => {
    const doc = await Counter.findOne({ key: prefix }).lean();
    return (doc?.seq ?? 0) + 1;
};

/** Sinh mã máy hoàn chỉnh, đảm bảo không trùng mã đã có (lặp tăng STT nếu kẹt). */
export const generateMachineCode = async (params: {
    type?: string;
    brandName?: string;
    ownershipType?: string;
    typeCodeOverride?: string;
}) => {
    const { code: typeCode } = await resolveTypeCode(params.type, params.typeCodeOverride);
    const brandCode = normalizeForCode(params.brandName);
    const originCode = originCodeOf(params.ownershipType);
    const prefix = buildMachineCodePrefix(typeCode, brandCode, originCode);

    for (let attempt = 0; attempt < 50; attempt += 1) {
        const seq = await nextSequence(prefix);
        const machineCode = `${prefix}-${padSequence(seq)}`;
        const exists = await Asset.exists({ machineCode });
        if (!exists) {
            return { machineCode, prefix, typeCode, brandCode, originCode, seq };
        }
    }
    throw new BadRequestError('Khong the sinh ma may duy nhat, vui long thu lai');
};

// ===== HTTP: gợi ý mã khi tạo máy =====

export const suggestAssetCode = async (req: Request, res: Response, next: NextFunction) => {
    const { type, brandId, ownershipType, typeCode: typeCodeOverride } = req.body ?? {};
    if (!normalizeTypeKey(type)) throw new BadRequestError('Vui long chon/nhap loai may truoc');
    if (!brandId) throw new BadRequestError('Vui long chon nhan hieu truoc');

    const brand = await Brand.findOne({ _id: brandId, isDeleted: { $ne: true } })
        .select('name')
        .lean();
    if (!brand) throw new BadRequestError('Nhan hieu khong ton tai');

    const { code: typeCode, isNew } = await resolveTypeCode(type, typeCodeOverride);
    const brandCode = normalizeForCode(brand.name);
    const originCode = originCodeOf(ownershipType);
    const prefix = buildMachineCodePrefix(typeCode, brandCode, originCode);
    const seq = await peekSequence(prefix);
    const code = `${prefix}-${padSequence(seq)}`;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { code, typeCode, brandCode, originCode, seq, prefix, typeCodeIsNew: isNew },
            message: 'Goi y ma may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// ===== Bảng mã loại máy: xem / sửa tay / AI gợi ý =====

type TypeCodeRow = {
    typeKey: string;
    label: string;
    assetCount: number;
    currentCode: string | null;
    suggestedCode: string;
};

/** Gom loại máy đang dùng (theo typeKey) + mã đã lưu + gợi ý thuật toán. */
const collectTypeCodeRows = async (): Promise<TypeCodeRow[]> => {
    const grouped = await Asset.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);

    // Nhiều biến thể gõ ("1k", "1K ") cùng typeKey -> gộp, giữ label xuất hiện nhiều nhất.
    const byKey = new Map<string, { label: string; labelCount: number; count: number }>();
    for (const row of grouped as { _id?: string; count: number }[]) {
        const label = String(row._id ?? '').trim();
        const typeKey = normalizeTypeKey(label);
        if (!typeKey) continue;
        const cur = byKey.get(typeKey);
        if (!cur) {
            byKey.set(typeKey, { label, labelCount: row.count, count: row.count });
        } else {
            cur.count += row.count;
            if (row.count > cur.labelCount) {
                cur.label = label;
                cur.labelCount = row.count;
            }
        }
    }

    const saved = await MachineTypeCode.find({ typeKey: { $in: [...byKey.keys()] } }).lean();
    const savedMap = new Map(saved.map((doc: any) => [doc.typeKey, doc.code as string]));

    return [...byKey.entries()]
        .map(([typeKey, info]) => ({
            typeKey,
            label: info.label,
            assetCount: info.count,
            currentCode: savedMap.get(typeKey) ?? null,
            suggestedCode: suggestTypeCode(info.label),
        }))
        .sort((a, b) => b.assetCount - a.assetCount);
};

export const listMachineTypeCodes = async (req: Request, res: Response) => {
    const rows = await collectTypeCodeRows();
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { total: rows.length, rows },
            message: 'Lay bang ma loai may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const saveTypeCodesSchema = z.object({
    items: z.array(z.object({ label: z.string().min(1), code: z.string().min(1).max(12) })).min(1),
});

/** Lưu mã loại hàng loạt (ghi đè mã đã lưu — dùng sau khi người dùng rà/sửa). */
export const saveMachineTypeCodes = async (req: Request, res: Response) => {
    const body = saveTypeCodesSchema.parse(req.body);
    for (const item of body.items) {
        await ensureTypeCode(item.label, item.code, true);
    }
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { updated: body.items.length },
            message: 'Da luu ma loai may',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

const aiTypeCodeRespSchema = z
    .object({ items: z.array(z.object({ i: z.number(), code: z.string() })).default([]) })
    .passthrough();

/**
 * AI gợi ý mã viết tắt cho toàn bộ loại máy (không lưu — chỉ đề xuất để người rà).
 * Thuật toán per-word không phân biệt được "kansai" (tên riêng -> K) với "nhbl"
 * (viết tắt phải giữ nguyên); AI hiểu ngữ nghĩa nên đặt mã chuẩn hơn và gom loại trùng nghĩa.
 */
export const aiSuggestMachineTypeCodes = async (req: Request, res: Response) => {
    const rows = await collectTypeCodeRows();
    if (!rows.length) {
        return res.status(StatusCodes.OK).json(
            customResponse({
                data: { total: 0, rows: [] },
                message: 'Khong co loai may nao',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }

    const list = rows
        .map((row, idx) => `${idx}. "${row.label}" (mã hiện tại: ${row.currentCode ?? 'chưa có'}, ${row.assetCount} máy)`)
        .join('\n');
    const system = [
        'Bạn đặt MÃ VIẾT TẮT cho loại máy của công ty may. Quy tắc:',
        '- Mã 1-6 ký tự, chỉ A-Z và 0-9, suy ra tự nhiên từ tên loại: "Máy 1 kim" -> 1K, "Máy vắt sổ 4 chỉ" -> VS4C, "Máy 2 kim cơ định" -> 2KCD, "Bàn ủi hơi công nghiệp" -> BUHCN, "Máy Kansai" -> K.',
        '- Tên loại vốn đã là viết tắt (vs4c, nhbl, 1kxv, epn...) thì GIỮ NGUYÊN, chỉ viết hoa.',
        '- Hai loại TRÙNG NGHĨA phải trả CÙNG một mã (vd "1k" và "Máy 1 kim" đều -> 1K; "vs4c" và "Máy vắt sổ 4 chỉ" đều -> VS4C).',
        '- Mã hiện tại chỉ để tham khảo; nếu nó vô lý (mất chữ, cụt) hãy đề xuất mã đúng.',
        'Trả về DUY NHẤT JSON: {"items":[{"i":number,"code":"MA"}]} đủ mọi dòng. Không giải thích, không markdown.',
    ].join('\n');

    const ai = await aiProviderService.generateJson<Record<string, unknown>>({
        feature: AI_FEATURES.MACHINE_TYPE_CODE,
        temperature: 0.1,
        maxTokens: 1200,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Đặt mã cho ${rows.length} loại máy sau:\n${list}` },
        ],
    });
    const parsed = aiTypeCodeRespSchema.parse(ai.data);
    const byIndex = new Map<number, string>();
    parsed.items.forEach((item) => {
        const code = normalizeForCode(item.code).slice(0, 12);
        if (code) byIndex.set(item.i, code);
    });

    const data = rows.map((row, idx) => ({ ...row, aiCode: byIndex.get(idx) ?? null }));
    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { total: data.length, rows: data, provider: ai.provider, model: ai.model },
            message: 'AI da de xuat ma loai may',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

// ===== Chuẩn hoá mã máy cũ về chuẩn =====

type NormalizationRow = {
    id: string;
    name?: string;
    plantName?: string;
    oldCode?: string;
    newCode: string;
    changed: boolean;
};

const appendOldCodeNote = (note: string | undefined, oldCode?: string) => {
    const trimmed = String(note ?? '').trim();
    if (!oldCode) return trimmed || undefined;
    const tag = `Mã cũ: ${oldCode}`;
    if (trimmed.includes(tag)) return trimmed;
    return trimmed ? `${trimmed}\n${tag}` : tag;
};

/** Tính phương án đặt lại mã cho toàn bộ máy chưa xoá (dùng chung cho preview và confirm). */
const computeNormalizationPlan = async () => {
    const assets = await Asset.find({ isDeleted: { $ne: true } })
        .select('name machineCode type ownershipType brandId plantId note createdAt')
        .populate('brandId', 'name')
        .populate('plantId', 'name')
        .sort({ createdAt: 1, _id: 1 })
        .lean();

    // Mã loại cho từng loại máy: ưu tiên mã đã lưu, còn lại gợi ý.
    const typeKeys = [...new Set(assets.map((a: any) => normalizeTypeKey(a.type)).filter(Boolean))];
    const savedTypeCodes = typeKeys.length
        ? await MachineTypeCode.find({ typeKey: { $in: typeKeys } })
              .select('typeKey code label')
              .lean()
        : [];
    const typeCodeMap = new Map<string, { code: string; label?: string }>();
    savedTypeCodes.forEach((doc: any) => typeCodeMap.set(doc.typeKey, { code: doc.code, label: doc.label }));

    const seqByPrefix = new Map<string, number>();
    const rows: NormalizationRow[] = [];

    for (const asset of assets as any[]) {
        const typeKey = normalizeTypeKey(asset.type);
        let resolved = typeCodeMap.get(typeKey);
        if (!resolved) {
            resolved = { code: suggestTypeCode(asset.type), label: String(asset.type ?? '').trim() };
            typeCodeMap.set(typeKey, resolved);
        }

        const brandCode = normalizeForCode(asset.brandId?.name);
        const originCode = originCodeOf(asset.ownershipType);
        const prefix = buildMachineCodePrefix(resolved.code, brandCode, originCode);

        const seq = (seqByPrefix.get(prefix) ?? 0) + 1;
        seqByPrefix.set(prefix, seq);
        const newCode = `${prefix}-${padSequence(seq)}`;

        rows.push({
            id: String(asset._id),
            name: asset.name,
            plantName: asset.plantId?.name,
            oldCode: asset.machineCode,
            newCode,
            changed: asset.machineCode !== newCode,
        });
    }

    return { assets, rows, typeCodeMap, seqByPrefix };
};

export const previewNormalizeAssetCodes = async (req: Request, res: Response, next: NextFunction) => {
    const { rows } = await computeNormalizationPlan();
    const changed = rows.filter((row) => row.changed);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                summary: { total: rows.length, willChange: changed.length, unchanged: rows.length - changed.length },
                rows,
            },
            message: 'Da tao phuong an chuan hoa ma may',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const confirmNormalizeAssetCodes = async (req: Request, res: Response, next: NextFunction) => {
    const { assets, rows, typeCodeMap, seqByPrefix } = await computeNormalizationPlan();

    // Ghi nhớ mã loại đã dùng (lần đầu thì lưu).
    for (const [, value] of typeCodeMap) {
        await ensureTypeCode(value.label, value.code);
    }

    const noteById = new Map(assets.map((a: any) => [String(a._id), a.note as string | undefined]));
    const operations: any[] = rows
        .filter((row) => row.changed)
        .map((row) => ({
            updateOne: {
                filter: { _id: row.id },
                update: {
                    $set: {
                        machineCode: row.newCode,
                        note: appendOldCodeNote(noteById.get(row.id), row.oldCode),
                        updatedBy: req.userId,
                    },
                },
            },
        }));

    let updated = 0;
    let failed = 0;
    if (operations.length) {
        try {
            const result = await Asset.bulkWrite(operations, { ordered: false });
            updated = result.modifiedCount ?? 0;
        } catch (error: any) {
            // ordered:false -> phần lớn vẫn ghi được; đếm số lỗi để báo lại.
            updated = error?.result?.modifiedCount ?? error?.result?.nModified ?? 0;
            failed = Array.isArray(error?.writeErrors) ? error.writeErrors.length : 0;
        }
    }

    // Đặt bộ đếm mỗi tiền tố = STT lớn nhất đã dùng để máy mới đánh số tiếp.
    for (const [prefix, maxSeq] of seqByPrefix) {
        await Counter.updateOne({ key: prefix }, { $max: { seq: maxSeq } }, { upsert: true });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { total: rows.length, willChange: operations.length, updated, failed },
            message: 'Da chuan hoa ma may thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
