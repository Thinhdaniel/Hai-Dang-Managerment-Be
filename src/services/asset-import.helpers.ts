import { ASSET_STATUS } from '@/constant/assetStatus';
import { BadRequestError } from '@/errors/customError';
import { createAssetSchema } from '@/validations/asset.validation';
import Brand from '@/models/Brand';
import Plant from '@/models/Plant';
import { assetRepository } from '@/repositories/asset.repository';
import { ensureTypeCode, generateMachineCode } from '@/services/machine-code.service';
import { generateUniqueMachinePublicId } from '@/utils/publicId';
import XLSX from 'xlsx';

type ImportPreviewValues = {
    name: string;
    machineCode: string;
    model: string;
    type: string;
    brand: string;
    plant: string;
    status: string;
};

export type AssetImportRowResult = {
    rowNumber: number;
    isValid: boolean;
    values: Partial<ImportPreviewValues>;
    errors: string[];
};

type AssetImportParsedRow = AssetImportRowResult & {
    payload?: Record<string, unknown>;
};

export type AssetImportPreviewResult = {
    summary: {
        totalRows: number;
        validRows: number;
        invalidRows: number;
    };
    rows: AssetImportRowResult[];
};

export type AssetImportConfirmResult = {
    summary: {
        totalRows: number;
        importedRows: number;
        failedRows: number;
    };
    rows: AssetImportRowResult[];
};

const HEADER_ALIASES: Record<string, string> = {
    name: 'name',
    tenmay: 'name',
    machinecode: 'machineCode',
    mamay: 'machineCode',
    code: 'machineCode',
    serial: 'serial',
    serialnumber: 'serial',
    type: 'type',
    machinetype: 'type',
    loaimay: 'type',
    model: 'model',
    machinemodel: 'model',
    dongmay: 'model',
    brandid: 'brandId',
    brand: 'brand',
    brandname: 'brand',
    nhanhieu: 'brand',
    plantid: 'plantId',
    plantcode: 'plantCode',
    cosocode: 'plantCode',
    plant: 'plant',
    plantname: 'plant',
    coso: 'plant',
    area: 'area',
    khuvuc: 'area',
    xuong: 'area',
    status: 'status',
    trangthai: 'status',
    purchasedate: 'purchaseDate',
    ngaymua: 'purchaseDate',
    purchaseprice: 'purchasePrice',
    giamua: 'purchasePrice',
    price: 'purchasePrice',
    note: 'note',
    ghichu: 'note',
    specifications: 'specifications',
    specs: 'specifications',
    thongsokythuat: 'specifications',
};

const stripDiacritics = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normalizeText = (value: unknown) => String(value ?? '').trim();

const normalizeLookup = (value: unknown) => stripDiacritics(normalizeText(value)).toLowerCase().replace(/\s+/g, ' ');

const normalizeHeader = (value: string) => normalizeLookup(value).replace(/[^a-z0-9]/g, '');

const normalizeMachineCodeKey = (value: string) => normalizeLookup(value).replace(/\s+/g, '');

const toCanonicalRow = (row: Record<string, unknown>) => {
    return Object.entries(row).reduce<Record<string, unknown>>((accumulator, [key, value]) => {
        const normalizedKey = HEADER_ALIASES[normalizeHeader(key)];
        if (normalizedKey) {
            accumulator[normalizedKey] = value;
        }
        return accumulator;
    }, {});
};

const parseStatus = (value: unknown) => {
    if (!normalizeText(value)) return ASSET_STATUS.ACTIVE;

    const normalizedValue = normalizeLookup(value).replace(/[\s_-]+/g, '');
    const statusMap: Record<string, ASSET_STATUS> = {
        active: ASSET_STATUS.ACTIVE,
        hoatdong: ASSET_STATUS.ACTIVE,
        maintenance: ASSET_STATUS.MAINTENANCE,
        baotri: ASSET_STATUS.MAINTENANCE,
        broken: ASSET_STATUS.BROKEN,
        loi: ASSET_STATUS.BROKEN,
        hong: ASSET_STATUS.BROKEN,
        borrowing: ASSET_STATUS.BORROWING,
        dangmuon: ASSET_STATUS.BORROWING,
        storage: ASSET_STATUS.STORAGE,
        tonkho: ASSET_STATUS.STORAGE,
        returnedtopartner: ASSET_STATUS.RETURNED_TO_PARTNER,
        datradoitac: ASSET_STATUS.RETURNED_TO_PARTNER,
        tradoitac: ASSET_STATUS.RETURNED_TO_PARTNER,
    };

    return statusMap[normalizedValue];
};

const parseDateValue = (value: unknown) => {
    if (value == null || value === '') return undefined;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }

    if (typeof value === 'number') {
        const parsed = XLSX.SSF.parse_date_code(value);
        if (!parsed) return undefined;
        return new Date(parsed.y, parsed.m - 1, parsed.d).toISOString();
    }

    const stringValue = normalizeText(value);
    if (!stringValue) return undefined;

    if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(stringValue)) {
        const normalized = stringValue.replace(/\//g, '-');
        const date = new Date(`${normalized}T00:00:00.000Z`);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    const ddmmyyyy = stringValue.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (ddmmyyyy) {
        const [, day, month, year] = ddmmyyyy;
        const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    const excelSerial = Number(stringValue);
    if (!Number.isNaN(excelSerial) && stringValue === String(excelSerial)) {
        const parsed = XLSX.SSF.parse_date_code(excelSerial);
        if (parsed) {
            return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).toISOString();
        }
    }

    const date = new Date(stringValue);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const parsePrice = (value: unknown) => {
    const stringValue = normalizeText(value);
    if (!stringValue) return undefined;

    const parsed = Number(stringValue.replace(/[, ]/g, ''));
    return Number.isNaN(parsed) ? undefined : parsed;
};

const parseSpecifications = (value: unknown) => {
    const stringValue = normalizeText(value);
    if (!stringValue) return undefined;

    try {
        const parsed = JSON.parse(stringValue);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, string | number>;
        }
    } catch {
        return Symbol.for('invalid-json');
    }

    return Symbol.for('invalid-json');
};

const readWorkbookRows = (fileBuffer: Buffer) => {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
        throw new BadRequestError('File Excel khong co du lieu de import');
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
        raw: false,
        defval: '',
        blankrows: false,
    });

    if (!rows.length) {
        throw new BadRequestError('File Excel khong co dong du lieu hop le');
    }

    return rows;
};

const buildReferenceMaps = async () => {
    const [brands, plants] = await Promise.all([
        Brand.find({ isDeleted: { $ne: true } })
            .select('_id name')
            .lean(),
        Plant.find({ isDeleted: { $ne: true } })
            .select('_id name code')
            .lean(),
    ]);

    return {
        brands: {
            byId: new Map(brands.map((brand) => [String(brand._id), String(brand.name)])),
            byName: new Map(brands.map((brand) => [normalizeLookup(brand.name), String(brand._id)])),
        },
        plants: {
            byId: new Map(
                plants.map((plant) => [String(plant._id), { id: String(plant._id), name: String(plant.name) }])
            ),
            byName: new Map(plants.map((plant) => [normalizeLookup(plant.name), String(plant._id)])),
            byCode: new Map(plants.map((plant) => [normalizeLookup(plant.code), String(plant._id)])),
            names: new Map(plants.map((plant) => [String(plant._id), String(plant.name)])),
        },
    };
};

const buildPreviewValues = (row: Record<string, unknown>) => ({
    name: normalizeText(row.name),
    machineCode: normalizeText(row.machineCode),
    model: normalizeText(row.model),
    type: normalizeText(row.type),
    brand: normalizeText(row.brand || row.brandId),
    plant: normalizeText(row.plant || row.plantCode || row.plantId),
    status: normalizeText(row.status) || ASSET_STATUS.ACTIVE,
});

const resolveBrandId = (
    row: Record<string, unknown>,
    brandIndexes: Awaited<ReturnType<typeof buildReferenceMaps>>['brands'],
    errors: string[]
) => {
    const brandIdCandidate = normalizeText(row.brandId);
    if (brandIdCandidate) {
        if (brandIndexes.byId.has(brandIdCandidate)) {
            return brandIdCandidate;
        }
        errors.push('Nhan hieu khong ton tai');
        return undefined;
    }

    const brandNameCandidate = normalizeText(row.brand);
    if (!brandNameCandidate) {
        errors.push('Nhan hieu khong duoc de trong');
        return undefined;
    }

    const resolvedBrandId = brandIndexes.byName.get(normalizeLookup(brandNameCandidate));
    if (!resolvedBrandId) {
        errors.push('Nhan hieu khong ton tai');
        return undefined;
    }

    return resolvedBrandId;
};

const resolvePlantId = (
    row: Record<string, unknown>,
    plantIndexes: Awaited<ReturnType<typeof buildReferenceMaps>>['plants'],
    errors: string[]
) => {
    const plantIdCandidate = normalizeText(row.plantId);
    if (plantIdCandidate) {
        if (plantIndexes.byId.has(plantIdCandidate)) {
            return plantIdCandidate;
        }
        errors.push('Co so khong ton tai');
        return undefined;
    }

    const plantCodeCandidate = normalizeText(row.plantCode);
    if (plantCodeCandidate) {
        const resolvedByCode = plantIndexes.byCode.get(normalizeLookup(plantCodeCandidate));
        if (resolvedByCode) return resolvedByCode;
        errors.push('Ma co so khong ton tai');
        return undefined;
    }

    const plantNameCandidate = normalizeText(row.plant);
    if (!plantNameCandidate) {
        errors.push('Co so khong duoc de trong');
        return undefined;
    }

    const resolvedPlantId = plantIndexes.byName.get(normalizeLookup(plantNameCandidate));
    if (!resolvedPlantId) {
        errors.push('Co so khong ton tai');
        return undefined;
    }

    return resolvedPlantId;
};

const summarizeRows = (rows: AssetImportParsedRow[]) => ({
    totalRows: rows.length,
    validRows: rows.filter((row) => row.isValid).length,
    invalidRows: rows.filter((row) => !row.isValid).length,
});

const parseImportRows = async (fileBuffer: Buffer, userId?: string) => {
    const rawRows = readWorkbookRows(fileBuffer);
    const references = await buildReferenceMaps();

    const parsedRows = rawRows.map<AssetImportParsedRow>((rawRow, index) => {
        const row = toCanonicalRow(rawRow);
        const rowNumber = index + 2;
        const errors: string[] = [];

        const brandId = resolveBrandId(row, references.brands, errors);
        const plantId = resolvePlantId(row, references.plants, errors);
        const status = parseStatus(row.status);
        const purchaseDate = parseDateValue(row.purchaseDate);
        const purchasePrice = parsePrice(row.purchasePrice);
        const specifications = parseSpecifications(row.specifications);

        if (normalizeText(row.status) && !status) {
            errors.push('Trang thai khong hop le');
        }

        if (normalizeText(row.purchaseDate) && !purchaseDate) {
            errors.push('Ngay mua khong hop le');
        }

        if (normalizeText(row.purchasePrice) && purchasePrice == null) {
            errors.push('Gia mua khong hop le');
        }

        if (normalizeText(row.specifications) && specifications === Symbol.for('invalid-json')) {
            errors.push('Thong so ky thuat phai la JSON hop le');
        }

        const candidatePayload = {
            name: normalizeText(row.name),
            machineCode: normalizeText(row.machineCode),
            serial: normalizeText(row.serial) || undefined,
            type: normalizeText(row.type),
            model: normalizeText(row.model),
            note: normalizeText(row.note) || undefined,
            status: status ?? ASSET_STATUS.ACTIVE,
            brandId,
            plantId,
            area: normalizeText(row.area) || undefined,
            purchaseDate,
            purchasePrice,
            specifications: specifications === Symbol.for('invalid-json') ? undefined : specifications,
        };

        const validation = createAssetSchema.safeParse(candidatePayload);
        if (!validation.success) {
            const validationErrors = Object.entries(validation.error.flatten().fieldErrors)
                .flatMap(([, fieldErrors]) => fieldErrors ?? [])
                .filter(Boolean);
            errors.push(...validationErrors);
        }

        return {
            rowNumber,
            isValid: errors.length === 0,
            values: buildPreviewValues(row),
            errors,
            payload:
                errors.length === 0
                    ? {
                          ...validation.data,
                          createdBy: userId,
                          updatedBy: userId,
                      }
                    : undefined,
        };
    });

    const duplicateRows = new Map<string, AssetImportParsedRow[]>();
    parsedRows.forEach((row) => {
        const machineCode = row.payload?.machineCode;
        if (!machineCode || typeof machineCode !== 'string') return;

        const key = normalizeMachineCodeKey(machineCode);
        const rowsForCode = duplicateRows.get(key) ?? [];
        rowsForCode.push(row);
        duplicateRows.set(key, rowsForCode);
    });

    duplicateRows.forEach((rowsForCode) => {
        if (rowsForCode.length < 2) return;
        rowsForCode.forEach((row) => {
            row.errors.push('Ma may bi trung trong file import');
            row.isValid = false;
            row.payload = undefined;
        });
    });

    const machineCodes = parsedRows
        .map((row) => row.payload?.machineCode)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (machineCodes.length) {
        const existingAssets = await assetRepository.findExistingMachineCodes(machineCodes);
        const existingMachineCodeSet = new Set(
            existingAssets.map((asset) => normalizeMachineCodeKey(String(asset.machineCode)))
        );

        parsedRows.forEach((row) => {
            const machineCode = row.payload?.machineCode;
            if (!machineCode) return;

            if (existingMachineCodeSet.has(normalizeMachineCodeKey(String(machineCode)))) {
                row.errors.push('Ma may da ton tai trong he thong');
                row.isValid = false;
                row.payload = undefined;
            }
        });
    }

    // Serial là số nhận dạng duy nhất: chặn trùng cả trong file lẫn với hệ thống. Bỏ qua dòng không nhập serial.
    const getSerialKey = (row: AssetImportParsedRow) => {
        const serial = row.payload?.serial;
        if (!serial || typeof serial !== 'string') return '';
        return normalizeMachineCodeKey(serial);
    };

    const duplicateSerialRows = new Map<string, AssetImportParsedRow[]>();
    parsedRows.forEach((row) => {
        const key = getSerialKey(row);
        if (!key) return;
        const rowsForSerial = duplicateSerialRows.get(key) ?? [];
        rowsForSerial.push(row);
        duplicateSerialRows.set(key, rowsForSerial);
    });

    duplicateSerialRows.forEach((rowsForSerial) => {
        if (rowsForSerial.length < 2) return;
        rowsForSerial.forEach((row) => {
            row.errors.push('Serial bi trung trong file import');
            row.isValid = false;
            row.payload = undefined;
        });
    });

    const serials = parsedRows
        .map((row) => row.payload?.serial)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (serials.length) {
        const existingBySerial = await assetRepository.findExistingSerials(serials);
        const existingSerialSet = new Set(existingBySerial.map((asset) => normalizeMachineCodeKey(String(asset.serial))));

        parsedRows.forEach((row) => {
            const key = getSerialKey(row);
            if (!key) return;

            if (existingSerialSet.has(key)) {
                row.errors.push('Serial da ton tai trong he thong');
                row.isValid = false;
                row.payload = undefined;
            }
        });
    }

    return parsedRows;
};

export const previewAssetImport = async (fileBuffer: Buffer, userId?: string): Promise<AssetImportPreviewResult> => {
    const rows = await parseImportRows(fileBuffer, userId);

    return {
        summary: summarizeRows(rows),
        rows: rows.map(({ payload, ...row }) => row),
    };
};

export const confirmAssetImport = async (fileBuffer: Buffer, userId?: string): Promise<AssetImportConfirmResult> => {
    const rows = await parseImportRows(fileBuffer, userId);
    const reservedPublicIds = new Set<string>();
    const brandNameById = new Map<string, string>();
    const validPayloads = [];

    for (const row of rows) {
        if (!row.payload) {
            continue;
        }

        const publicId = await generateUniqueMachinePublicId(
            async (candidate) =>
                reservedPublicIds.has(candidate) || Boolean(await assetRepository.existsByPublicId(candidate))
        );
        reservedPublicIds.add(publicId);

        // Dòng để trống mã máy -> tự sinh mã thông minh theo loại-nhãn-nguồn-STT.
        let machineCode = typeof row.payload.machineCode === 'string' ? row.payload.machineCode.trim() : '';
        if (!machineCode) {
            const brandId = String(row.payload.brandId ?? '');
            let brandName = brandNameById.get(brandId);
            if (brandName === undefined) {
                const brand = await Brand.findById(brandId).select('name').lean();
                brandName = brand?.name ?? '';
                brandNameById.set(brandId, brandName);
            }
            const generated = await generateMachineCode({
                type: typeof row.payload.type === 'string' ? row.payload.type : undefined,
                brandName,
                ownershipType: typeof row.payload.ownershipType === 'string' ? row.payload.ownershipType : undefined,
            });
            machineCode = generated.machineCode;
            await ensureTypeCode(typeof row.payload.type === 'string' ? row.payload.type : undefined, generated.typeCode);
        }

        validPayloads.push({
            ...row.payload,
            machineCode,
            publicId,
        });
    }

    if (validPayloads.length) {
        await assetRepository.insertMany(validPayloads);
    }

    return {
        summary: {
            totalRows: rows.length,
            importedRows: validPayloads.length,
            failedRows: rows.length - validPayloads.length,
        },
        rows: rows.map(({ payload, ...row }) => row),
    };
};
