import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import Plant from '@/models/Plant';
import Brand from '@/models/Brand';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import customResponse from '@/utils/response';
import { aiProviderService } from '@/services/ai/ai-provider.service';

type ResolvedFilters = {
    search?: string;
    status?: string;
    ownershipType?: string;
    plantId?: string;
    brandId?: string;
};

type AssetSearchResult = {
    filters: ResolvedFilters;
    intent: 'search' | 'create_transfer';
    explanation: string;
    matchedPlantName?: string;
    matchedBrandName?: string;
    suggestedActions: { label: string; hint: string }[];
    provider: string;
};

// Bo dau tieng Viet de so khop ten co so / hang / tu khoa
const normalize = (value?: string) =>
    (value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

const STATUS_LABEL: Record<string, string> = {
    [ASSET_STATUS.ACTIVE]: 'Hoat dong',
    [ASSET_STATUS.MAINTENANCE]: 'Bao tri',
    [ASSET_STATUS.BROKEN]: 'Loi / hong',
    [ASSET_STATUS.BORROWING]: 'Dang muon',
    [ASSET_STATUS.STORAGE]: 'Ton kho / de khong',
    [ASSET_STATUS.RETURNED_TO_PARTNER]: 'Da tra doi tac',
};

const OWNERSHIP_LABEL: Record<string, string> = {
    [ASSET_OWNERSHIP_TYPE.OWNED]: 'May Hai Dang (so huu)',
    [ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED]: 'May muon cua doi tac',
    [ASSET_OWNERSHIP_TYPE.RENTAL]: 'May thue',
};

const VALID_STATUS = new Set<string>(Object.values(ASSET_STATUS));
const VALID_OWNERSHIP = new Set<string>(Object.values(ASSET_OWNERSHIP_TYPE));

// Tu khoa nghiep vu -> trang thai (dung cho ca prompt va fallback)
const STATUS_KEYWORDS: { keywords: string[]; status: string }[] = [
    {
        keywords: [
            'khong su dung',
            'khong dung',
            'khong hoat dong',
            'de khong',
            'de kho',
            'nhan roi',
            'ranh',
            'ton kho',
            'trong kho',
            'nhan roi',
        ],
        status: ASSET_STATUS.STORAGE,
    },
    { keywords: ['hong', 'loi', 'hu', 'hong hoc'], status: ASSET_STATUS.BROKEN },
    { keywords: ['bao tri', 'sua chua', 'bao duong'], status: ASSET_STATUS.MAINTENANCE },
    {
        keywords: ['dang chay', 'dang hoat dong', 'hoat dong', 'dang dung', 'dang van hanh'],
        status: ASSET_STATUS.ACTIVE,
    },
    { keywords: ['dang muon', 'cho muon', 'di muon'], status: ASSET_STATUS.BORROWING },
    { keywords: ['da tra doi tac', 'tra doi tac', 'tra lai doi tac'], status: ASSET_STATUS.RETURNED_TO_PARTNER },
];

const OWNERSHIP_KEYWORDS: { keywords: string[]; ownershipType: string }[] = [
    {
        keywords: ['may muon', 'muon doi tac', 'muon cua doi tac', 'doi tac cho muon'],
        ownershipType: ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED,
    },
    { keywords: ['may thue', 'di thue', 'thue ngoai'], ownershipType: ASSET_OWNERSHIP_TYPE.RENTAL },
    { keywords: ['may hai dang', 'so huu', 'cua cong ty', 'tu co'], ownershipType: ASSET_OWNERSHIP_TYPE.OWNED },
];

const buildSystemPrompt = (plantNames: string[], brandNames: string[]) =>
    [
        'Ban la bo trich xuat bo loc cho danh sach may moc thiet bi cua mot cong ty san xuat.',
        'Nhiem vu: doc cau hoi tieng Viet cua nguoi dung va tra ve DUY NHAT mot doi tuong JSON mo ta bo loc can ap dung. Khong giai thich ngoai JSON.',
        '',
        'Cau truc JSON bat buoc:',
        '{',
        '  "intent": "search" | "create_transfer",',
        '  "search": string | null,            // tu khoa ten/ma/serial/loai/model may, KHONG chua trang thai/co so/hang',
        '  "status": string | null,            // mot trong cac ma trang thai ben duoi hoac null',
        '  "ownershipType": string | null,     // mot trong cac ma nguon goc ben duoi hoac null',
        '  "plantName": string | null,         // ten co so neu nguoi dung neu, chon tu danh sach co so',
        '  "brandName": string | null,         // ten hang/nhan hieu neu nguoi dung neu',
        '  "explanation": string               // 1 cau tieng Viet ngan giai thich ban da hieu gi',
        '}',
        '',
        'Ma trang thai (status) va y nghia:',
        `- "${ASSET_STATUS.ACTIVE}": may dang hoat dong / dang chay / dang dung`,
        `- "${ASSET_STATUS.STORAGE}": may de kho, KHONG su dung, nhan roi, ton kho`,
        `- "${ASSET_STATUS.BROKEN}": may loi / hong / hu`,
        `- "${ASSET_STATUS.MAINTENANCE}": may dang bao tri / sua chua`,
        `- "${ASSET_STATUS.BORROWING}": may dang cho muon / dang muon`,
        `- "${ASSET_STATUS.RETURNED_TO_PARTNER}": may da tra lai doi tac`,
        'Khi nguoi dung hoi "may khong su dung", "may khong dung", "may de khong", "may ranh" => status = "' +
            ASSET_STATUS.STORAGE +
            '".',
        '',
        'Ma nguon goc (ownershipType):',
        `- "${ASSET_OWNERSHIP_TYPE.OWNED}": may cong ty so huu`,
        `- "${ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED}": may muon cua doi tac`,
        `- "${ASSET_OWNERSHIP_TYPE.RENTAL}": may thue`,
        '',
        plantNames.length ? `Danh sach co so hien co: ${plantNames.join(', ')}.` : 'Khong co danh sach co so.',
        brandNames.length ? `Danh sach hang/nhan hieu hien co: ${brandNames.join(', ')}.` : '',
        '',
        'Quy tac:',
        '- Neu cau hoi co nhac ten co so (vi du "co so 2", "CS2", "nha may A", hoac mot ten trong danh sach co so) thi PHAI dien dung ten do vao plantName.',
        '- Neu cau hoi co nhac ten hang/nhan hieu thi dien vao brandName.',
        '- Neu nguoi dung muon tao lenh dieu chuyen/chuyen may => intent = "create_transfer", dong thoi van dien search/status neu xac dinh duoc may.',
        '- Neu khong chac mot truong nao thi de null. Khong bia gia tri.',
        '- search chi chua ten/loai may that su (vi du "may tien", "CNC", "may han"), khong nhet trang thai vao search.',
        '- Tra ve JSON hop le, khong kem markdown, khong kem text thua.',
    ]
        .filter(Boolean)
        .join('\n');

const resolveByName = (
    candidates: { id: string; name: string }[],
    rawName?: string
): { id: string; name: string } | undefined => {
    const target = normalize(rawName);
    if (!target) return undefined;
    let match = candidates.find((item) => normalize(item.name) === target);
    if (match) return match;
    match = candidates.find((item) => {
        const n = normalize(item.name);
        return n && (n.includes(target) || target.includes(n));
    });
    return match;
};

// Kiem tra tu khoa search co that su bat nguon tu cau hoi khong (chong ao giac)
const isSearchGrounded = (search: string, query: string) => {
    const normSearch = normalize(search);
    const normQuery = normalize(query);
    if (!normSearch) return false;
    if (normQuery.includes(normSearch)) return true;
    const tokens = normSearch.split(' ').filter((token) => token.length > 1);
    if (!tokens.length) return false;
    const overlap = tokens.filter((token) => normQuery.includes(token)).length;
    // Can it nhat mot nua so tu khoa xuat hien trong cau hoi
    return overlap >= Math.ceil(tokens.length / 2);
};

// Du phong khi Ollama loi: suy luan bo loc bang tu khoa
const heuristicParse = (query: string) => {
    const norm = normalize(query);
    let status: string | undefined;
    for (const rule of STATUS_KEYWORDS) {
        if (rule.keywords.some((kw) => norm.includes(kw))) {
            status = rule.status;
            break;
        }
    }
    let ownershipType: string | undefined;
    for (const rule of OWNERSHIP_KEYWORDS) {
        if (rule.keywords.some((kw) => norm.includes(kw))) {
            ownershipType = rule.ownershipType;
            break;
        }
    }
    const intent: 'search' | 'create_transfer' =
        norm.includes('dieu chuyen') || norm.includes('chuyen may') || norm.includes('tao lenh')
            ? 'create_transfer'
            : 'search';

    return { status, ownershipType, intent };
};

const askAiProvider = async (query: string, plantNames: string[], brandNames: string[]) => {
    const result = await aiProviderService.generateJson<Record<string, unknown>>({
        feature: 'asset-search',
        temperature: 0.1,
        maxTokens: 400,
        messages: [
            { role: 'system', content: buildSystemPrompt(plantNames, brandNames) },
            { role: 'user', content: query },
        ],
    });

    return result;
};

export const aiAssetSearch = async (req: Request, res: Response) => {
    const query = String(req.body.query || '').trim();

    const [plantDocs, brandDocs] = await Promise.all([
        Plant.find({ isDeleted: { $ne: true } })
            .select('_id name')
            .lean(),
        Brand.find({ isDeleted: { $ne: true } })
            .select('_id name')
            .lean(),
    ]);

    const plants = plantDocs.map((doc: any) => ({ id: String(doc._id), name: String(doc.name ?? '') }));
    const brands = brandDocs.map((doc: any) => ({ id: String(doc._id), name: String(doc.name ?? '') }));

    let result: AssetSearchResult;

    try {
        const aiResult = await askAiProvider(
            query,
            plants.map((plant) => plant.name),
            brands.map((brand) => brand.name)
        );
        const parsed = aiResult.data;

        const rawStatus = typeof parsed.status === 'string' ? String(parsed.status).trim() : '';
        const rawOwnership = typeof parsed.ownershipType === 'string' ? String(parsed.ownershipType).trim() : '';
        const matchedPlant = resolveByName(plants, typeof parsed.plantName === 'string' ? parsed.plantName : undefined);
        const matchedBrand = resolveByName(brands, typeof parsed.brandName === 'string' ? parsed.brandName : undefined);
        const intent = parsed.intent === 'create_transfer' ? 'create_transfer' : 'search';
        // Chong model bia tu khoa: chi giu search neu no thuc su xuat hien trong cau hoi cua nguoi dung
        const rawSearch =
            typeof parsed.search === 'string' && parsed.search.trim() ? parsed.search.trim().slice(0, 200) : '';
        const searchTerm = rawSearch && isSearchGrounded(rawSearch, query) ? rawSearch : undefined;

        const filters: ResolvedFilters = {
            search: searchTerm,
            status: VALID_STATUS.has(rawStatus) ? rawStatus : undefined,
            ownershipType: VALID_OWNERSHIP.has(rawOwnership) ? rawOwnership : undefined,
            plantId: matchedPlant?.id,
            brandId: matchedBrand?.id,
        };

        const explanation =
            typeof parsed.explanation === 'string' && parsed.explanation.trim()
                ? parsed.explanation.trim().slice(0, 300)
                : 'Da dien bo loc theo cau hoi cua ban.';

        result = {
            filters,
            intent,
            explanation,
            matchedPlantName: matchedPlant?.name,
            matchedBrandName: matchedBrand?.name,
            suggestedActions:
                intent === 'create_transfer'
                    ? [{ label: 'Tao lenh dieu chuyen', hint: 'Chon may trong bang roi bam nut Dieu chuyen' }]
                    : [],
            provider: aiResult.provider,
        };
    } catch {
        const { status, ownershipType, intent } = heuristicParse(query);
        const matchedPlant = resolveByName(plants, query);
        const matchedBrand = resolveByName(brands, query);

        result = {
            filters: {
                search: status || ownershipType || matchedPlant || matchedBrand ? undefined : query.slice(0, 200),
                status,
                ownershipType,
                plantId: matchedPlant?.id,
                brandId: matchedBrand?.id,
            },
            intent,
            explanation: status
                ? `AI local tam thoi ban, da loc theo trang thai "${STATUS_LABEL[status]}".`
                : 'AI local tam thoi ban, da tim theo tu khoa ban nhap.',
            matchedPlantName: matchedPlant?.name,
            matchedBrandName: matchedBrand?.name,
            suggestedActions:
                intent === 'create_transfer'
                    ? [{ label: 'Tao lenh dieu chuyen', hint: 'Chon may trong bang roi bam nut Dieu chuyen' }]
                    : [],
            provider: 'fallback',
        };
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                ...result,
                statusLabel: result.filters.status ? STATUS_LABEL[result.filters.status] : undefined,
                ownershipLabel: result.filters.ownershipType
                    ? OWNERSHIP_LABEL[result.filters.ownershipType]
                    : undefined,
            },
            message: 'Da phan tich cau hoi tim kiem',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
