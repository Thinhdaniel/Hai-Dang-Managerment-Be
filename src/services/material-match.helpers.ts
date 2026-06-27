import Material from '@/models/Material';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';

export type MaterialCatalogMatchStatus = 'matched' | 'unmatched' | 'ignored' | 'ambiguous';

export type MaterialMatchInput = {
    materialId?: unknown;
    materialName?: string;
    unit?: string;
    catalogStatus?: MaterialCatalogMatchStatus;
};

export type MaterialMatchResult = {
    material?: any;
    status: MaterialCatalogMatchStatus;
    confidence: number;
    reason: string;
    autoMatched: boolean;
    candidateCount: number;
};

type IndexedMaterial = {
    id: string;
    material: any;
    codeNorm: string;
    codeCompact: string;
    nameNorm: string;
    nameCompact: string;
    unitNorm: string;
    searchText: string;
};

type MaterialIntentCandidate = {
    code?: unknown;
    name?: unknown;
    unit?: unknown;
    category?: unknown;
    description?: unknown;
    searchText?: unknown;
};

const MATERIAL_KIND_GROUPS = [
    { key: 'belt', labels: ['curoa', 'day curoa', 'day dai', 'belt'] },
    { key: 'looper', labels: ['moc', 'mo tren', 'mo duoi', 'looper'] },
    { key: 'needle', labels: ['kim', 'needle'] },
    { key: 'oil', labels: ['dau', 'nhot', 'oil'] },
    { key: 'thread', labels: ['chi may', 'cuon chi', 'thread'] },
    { key: 'knife', labels: ['dao', 'knife'] },
    { key: 'presser_foot', labels: ['chan vit', 'presser foot'] },
    { key: 'bobbin', labels: ['suot', 'thoi', 'bobbin'] },
    { key: 'zipper', labels: ['khoa keo', 'khoa', 'zip', 'zipper'] },
    { key: 'button', labels: ['cuc', 'nut', 'button'] },
    { key: 'motor', labels: ['motor', 'dong co'] },
    { key: 'sensor', labels: ['cam bien', 'sensor'] },
    { key: 'bearing', labels: ['bac dan', 'vong bi', 'bearing'] },
];

export const normalizeMaterialLookupText = (value?: unknown) =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');

const compactLookupText = (value?: unknown) => normalizeMaterialLookupText(value).replace(/\s+/g, '');

const findLabelIndex = (text: string, label: string) => {
    const normalizedLabel = normalizeMaterialLookupText(label);
    if (!normalizedLabel) return -1;
    const match = new RegExp(`(^| )${normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).exec(text);
    return match?.index ?? -1;
};

const detectMaterialIntentKinds = (value?: unknown) => {
    const text = normalizeMaterialLookupText(value);
    const kinds = new Set<string>();

    MATERIAL_KIND_GROUPS.forEach((group) => {
        if (group.labels.some((label) => findLabelIndex(text, label) >= 0)) {
            kinds.add(group.key);
        }
    });

    return kinds;
};

const getPrimaryMaterialIntentKind = (value?: unknown) => {
    const text = normalizeMaterialLookupText(value);
    let best: { key: string; index: number; length: number } | undefined;

    MATERIAL_KIND_GROUPS.forEach((group) => {
        group.labels.forEach((label) => {
            const normalizedLabel = normalizeMaterialLookupText(label);
            const index = findLabelIndex(text, label);
            if (index < 0) return;
            if (!best || index < best.index || (index === best.index && normalizedLabel.length > best.length)) {
                best = { key: group.key, index, length: normalizedLabel.length };
            }
        });
    });

    return best?.key;
};

export const getMaterialKindConflict = (query: unknown, candidate: MaterialIntentCandidate) => {
    const queryKind = getPrimaryMaterialIntentKind(query);
    if (!queryKind) return undefined;

    const candidateText = [
        candidate.searchText,
        candidate.code,
        candidate.name,
        candidate.unit,
        candidate.category,
        candidate.description,
    ]
        .filter(Boolean)
        .join(' ');
    const candidateKinds = detectMaterialIntentKinds(candidateText);
    if (!candidateKinds.size) return undefined;

    return candidateKinds.has(queryKind)
        ? undefined
        : { queryKinds: [queryKind], candidateKinds: [...candidateKinds] };
};

const toMaterialId = (value: unknown) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        const maybeObject = value as any;
        if (typeof maybeObject.toHexString === 'function') return maybeObject.toHexString();
        if (maybeObject._id) return toMaterialId(maybeObject._id);
        if (typeof maybeObject.id === 'string') return maybeObject.id;
    }
    return String(value);
};

const addToMap = <T>(map: Map<string, T[]>, key: string, value: T) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
};

const unique = <T>(items?: T[]) => (items?.length === 1 ? items[0] : undefined);

const buildIndex = (materials: any[]) => {
    const indexed = materials.map((material) => {
        const codeNorm = normalizeMaterialLookupText(material.code);
        const nameNorm = normalizeMaterialLookupText(material.name);
        const unitNorm = normalizeMaterialLookupText(material.unit);
        return {
            id: String(material._id),
            material,
            codeNorm,
            codeCompact: compactLookupText(material.code),
            nameNorm,
            nameCompact: compactLookupText(material.name),
            unitNorm,
            searchText: normalizeMaterialLookupText(
                [material.code, material.name, material.unit, material.category, material.description]
                    .filter(Boolean)
                    .join(' ')
            ),
        };
    });

    const byId = new Map<string, IndexedMaterial>();
    const byCode = new Map<string, IndexedMaterial[]>();
    const byCodeCompact = new Map<string, IndexedMaterial[]>();
    const byName = new Map<string, IndexedMaterial[]>();
    const byNameUnit = new Map<string, IndexedMaterial[]>();

    indexed.forEach((item) => {
        byId.set(item.id, item);
        addToMap(byCode, item.codeNorm, item);
        addToMap(byCodeCompact, item.codeCompact, item);
        addToMap(byName, item.nameNorm, item);
        addToMap(byNameUnit, `${item.nameNorm}::${item.unitNorm}`, item);
    });

    return { indexed, byId, byCode, byCodeCompact, byName, byNameUnit };
};

const scoreMaterial = (item: IndexedMaterial, query: string, unit?: string) => {
    const q = normalizeMaterialLookupText(query);
    const qCompact = compactLookupText(query);
    const unitNorm = normalizeMaterialLookupText(unit);
    if (!q) return 0;

    let score = 0;
    if (item.codeNorm === q || item.codeCompact === qCompact) score += 100;
    else if (item.codeNorm.startsWith(q) || item.codeCompact.startsWith(qCompact)) score += 88;

    if (item.nameNorm === q || item.nameCompact === qCompact) score += 92;
    else if (item.nameNorm.startsWith(q)) score += 78;
    else if (item.nameNorm.includes(q) || q.includes(item.nameNorm)) score += 66;

    const tokens = q.split(' ').filter(Boolean);
    if (tokens.length) {
        const matchedTokens = tokens.filter((token) => item.searchText.includes(token)).length;
        score += Math.round((matchedTokens / tokens.length) * 48);
    }

    if (unitNorm && item.unitNorm === unitNorm) score += 10;

    if (getMaterialKindConflict(query, item)) {
        score = Math.min(score, 62);
    }

    return Math.min(score, 100);
};

const buildResult = (
    material: IndexedMaterial | undefined,
    status: MaterialCatalogMatchStatus,
    confidence: number,
    reason: string,
    autoMatched: boolean,
    candidateCount = material ? 1 : 0
): MaterialMatchResult => ({
    material: material?.material,
    status,
    confidence,
    reason,
    autoMatched,
    candidateCount,
});

export const matchMaterialsForItems = async (
    items: MaterialMatchInput[],
    options: { session?: ClientSession } = {}
): Promise<MaterialMatchResult[]> => {
    const explicitIds = items.map((item) => toMaterialId(item.materialId)).filter(Boolean) as string[];
    const needsLookupPool = items.some(
        (item) => item.catalogStatus !== 'ignored' && !toMaterialId(item.materialId) && item.materialName?.trim()
    );

    if (!explicitIds.length && !needsLookupPool) {
        return items.map((item) =>
            item.catalogStatus === 'ignored'
                ? buildResult(undefined, 'ignored', 0, 'ignored_by_user', false, 0)
                : buildResult(undefined, 'unmatched', 0, 'empty_lookup', false, 0)
        );
    }

    const query = Material.find({
        isDeleted: { $ne: true },
        isActive: { $ne: false },
        ...(needsLookupPool ? {} : { _id: { $in: explicitIds.filter((id) => mongoose.isValidObjectId(id)) } }),
    })
        .select('_id code name unit category description trackInventory isActive')
        .lean();

    if (options.session) {
        query.session(options.session);
    }

    const materialIndex = buildIndex(await query);

    return items.map((item) => {
        if (item.catalogStatus === 'ignored') {
            return buildResult(undefined, 'ignored', 0, 'ignored_by_user', false, 0);
        }

        const explicitId = toMaterialId(item.materialId);
        if (explicitId) {
            const selected = materialIndex.byId.get(explicitId);
            return selected
                ? buildResult(selected, 'matched', 100, 'selected_material_id', false, 1)
                : buildResult(undefined, 'unmatched', 0, 'missing_explicit_id', false, 0);
        }

        const name = item.materialName?.trim() ?? '';
        const nameNorm = normalizeMaterialLookupText(name);
        const nameCompact = compactLookupText(name);
        const unitNorm = normalizeMaterialLookupText(item.unit);
        if (!nameNorm) {
            return buildResult(undefined, 'unmatched', 0, 'empty_name', false, 0);
        }

        const exactCode =
            unique(materialIndex.byCode.get(nameNorm)) ?? unique(materialIndex.byCodeCompact.get(nameCompact));
        if (exactCode) {
            return buildResult(exactCode, 'matched', 100, 'exact_code', true, 1);
        }

        const exactNameUnit = unitNorm ? unique(materialIndex.byNameUnit.get(`${nameNorm}::${unitNorm}`)) : undefined;
        if (exactNameUnit) {
            return buildResult(exactNameUnit, 'matched', 98, 'exact_name_unit', true, 1);
        }

        const exactNameCandidates = materialIndex.byName.get(nameNorm) ?? [];
        const exactName = unique(exactNameCandidates);
        if (exactName) {
            return buildResult(exactName, 'matched', 94, 'exact_name_unique', true, 1);
        }

        if (exactNameCandidates.length > 1) {
            return buildResult(undefined, 'ambiguous', 88, 'exact_name_ambiguous', false, exactNameCandidates.length);
        }

        const scored = materialIndex.indexed
            .map((material) => ({ material, score: scoreMaterial(material, name, item.unit) }))
            .filter((entry) => entry.score >= 68)
            .sort(
                (a, b) => b.score - a.score || a.material.material.name.localeCompare(b.material.material.name, 'vi')
            );

        const best = scored[0];
        if (!best) {
            return buildResult(undefined, 'unmatched', 0, 'no_candidate', false, 0);
        }

        const secondScore = scored[1]?.score ?? 0;
        const uniqueStrongMatch = best.score >= 96 && best.score - secondScore >= 12;
        return buildResult(
            best.material,
            uniqueStrongMatch ? 'matched' : 'ambiguous',
            best.score,
            uniqueStrongMatch ? 'strong_unique_match' : 'fuzzy_candidate',
            uniqueStrongMatch,
            scored.length
        );
    });
};
