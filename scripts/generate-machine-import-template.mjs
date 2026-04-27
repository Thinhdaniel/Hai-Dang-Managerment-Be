import fs from 'node:fs/promises';
import path from 'node:path';
import XLSX from 'xlsx';

const outputDir = path.resolve('./outputs');
const outputPath = path.join(outputDir, 'machine-import-template-1020.xlsx');

const plants = [
    {
        code: 'BD01',
        name: 'Nha may Binh Duong',
        areas: [
            'Xuong May 1 - Chuyen 01',
            'Xuong May 1 - Chuyen 02',
            'Xuong Ao Polo - Line A',
            'Xuong So Mi - Cum 03',
            'Khu may chi tiet nho',
            'Xuong Quan Kaki - Line 05',
        ],
    },
    {
        code: 'HCM01',
        name: 'Nha may HCM',
        areas: [
            'Xuong Thun - Chuyen 01',
            'Xuong Thun - Chuyen 03',
            'Xuong Quan Tay - Cum 02',
            'Khu hoan thien',
            'Xuong Jacket - Chuyen B',
            'Khu may mau',
        ],
    },
    {
        code: 'KHO01',
        name: 'Kho tong phu lieu va may du phong',
        areas: [
            'Khu may du phong',
            'Khu cat vai du phong',
            'Kho thanh ly thiet bi',
            'Kho vat tu may mac',
            'Khu test may dau vao',
            'Khu luu kho line backup',
        ],
    },
];

const statusSequence = [
    'active',
    'active',
    'active',
    'active',
    'active',
    'active',
    'maintenance',
    'active',
    'storage',
    'borrowing',
    'active',
    'broken',
];

const catalogs = [
    {
        type: 'May 1 kim dien tu',
        model: 'Juki DDL-8000A',
        brand: 'Juki',
        basePrice: 18500000,
        linePrefixes: ['Ao Polo', 'Ao So Mi', 'Ao Thun'],
    },
    {
        type: 'May 1 kim dien tu',
        model: 'Brother S-7300A',
        brand: 'Brother',
        basePrice: 19200000,
        linePrefixes: ['Ao So Mi', 'Quan Tay', 'Ao Kieu'],
    },
    {
        type: 'May 1 kim dien tu',
        model: 'Jack A4B',
        brand: 'Jack',
        basePrice: 14800000,
        linePrefixes: ['Dong phuc', 'Ao Thun', 'Ao tre em'],
    },
    {
        type: 'May vat so 4 chi',
        model: 'Jack E4S',
        brand: 'Jack',
        basePrice: 12800000,
        linePrefixes: ['Ao Thun', 'Do tre em', 'Ao lot'],
    },
    {
        type: 'May vat so 4 chi',
        model: 'Pegasus M952-52H',
        brand: 'Pegasus',
        basePrice: 15600000,
        linePrefixes: ['Ao Thun', 'Quan short', 'Ao khoac nhe'],
    },
    {
        type: 'May kansai',
        model: 'Siruba F007K',
        brand: 'Siruba',
        basePrice: 16200000,
        linePrefixes: ['Ao Thun', 'Ao the thao', 'Do mac nha'],
    },
    {
        type: 'May kansai',
        model: 'Pegasus W500',
        brand: 'Pegasus',
        basePrice: 17600000,
        linePrefixes: ['Ao thun cao cap', 'Do bo', 'Legging'],
    },
    {
        type: 'May 2 kim co dinh',
        model: 'Brother LH-3528A',
        brand: 'Brother',
        basePrice: 21900000,
        linePrefixes: ['Quan Tay', 'Ao Jacket', 'Dong phuc cong so'],
    },
    {
        type: 'May 2 kim co dinh',
        model: 'Juki LH-3568A',
        brand: 'Juki',
        basePrice: 22800000,
        linePrefixes: ['Quan Kaki', 'Ao Bao Ho', 'Ao Vest nhe'],
    },
    {
        type: 'May dinh bo',
        model: 'Juki LK-1900B',
        brand: 'Juki',
        basePrice: 28600000,
        linePrefixes: ['Quan Kaki', 'Quan Jeans', 'Ao Bao Ho'],
    },
    {
        type: 'May dinh bo',
        model: 'Brother KE-430HS',
        brand: 'Brother',
        basePrice: 30100000,
        linePrefixes: ['Ao So Mi', 'Ao Khoac', 'Dong phuc'],
    },
    {
        type: 'May thua khuy dien tu',
        model: 'Brother HE-800C',
        brand: 'Brother',
        basePrice: 33400000,
        linePrefixes: ['Ao So Mi', 'Dong phuc', 'Ao Bao Ho'],
    },
    {
        type: 'May thua khuy dien tu',
        model: 'Juki LBH-1790A',
        brand: 'Juki',
        basePrice: 34800000,
        linePrefixes: ['Ao So Mi cao cap', 'Ao vest', 'Dong phuc'],
    },
    {
        type: 'May cat vai dung',
        model: 'Pegasus KM RS-100',
        brand: 'Pegasus',
        basePrice: 9700000,
        linePrefixes: ['Cat vai mau', 'Cat bo phan nho', 'Cat line du phong'],
    },
    {
        type: 'May cat vai dung',
        model: 'Pegasus KS-AUV',
        brand: 'Pegasus',
        basePrice: 11200000,
        linePrefixes: ['Cat lot', 'Cat bo co', 'Cat tay ao'],
    },
    {
        type: 'Ban ui hoi cong nghiep',
        model: 'Jack J-802',
        brand: 'Jack',
        basePrice: 6800000,
        linePrefixes: ['Hoan thien', 'Dong goi', 'Kiem phom'],
    },
    {
        type: 'Ban ui hoi cong nghiep',
        model: 'Brother BP-900',
        brand: 'Brother',
        basePrice: 7200000,
        linePrefixes: ['Hoan thien ao so mi', 'Xu ly nep gap', 'Dong goi xuat hang'],
    },
];

const toMachineCode = (index) => `IMP${String(index).padStart(5, '0')}`;

const toSerial = (catalog, index, purchaseYear) => {
    const brandCode = catalog.brand.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const modelCode = catalog.model.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    return `${brandCode}-${modelCode}-${purchaseYear}-${String(index).padStart(5, '0')}`;
};

const toPurchaseDate = (index) => {
    const year = 2022 + (index % 4);
    const month = (index % 12) + 1;
    const day = ((index * 3) % 27) + 1;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const toPurchasePrice = (catalog, index) => {
    const delta = ((index % 9) - 4) * 180000;
    return Math.max(4500000, catalog.basePrice + delta);
};

const toNote = (status, plantCode, linePrefix) => {
    if (status === 'maintenance') return `Bao tri dinh ky cho line ${linePrefix.toLowerCase()} tai ${plantCode}`;
    if (status === 'broken') return `Tam dung de kiem tra cum truyen dong tai ${plantCode}`;
    if (status === 'borrowing') return `Dang bo tri cho line mau/ho tro san xuat tam thoi tai ${plantCode}`;
    if (status === 'storage') return `May du phong dang luu kho san sang dieu phoi`;
    return `Van hanh on dinh cho line ${linePrefix.toLowerCase()} tai ${plantCode}`;
};

const toAssetName = (catalog, linePrefix, lineNo) => {
    const brandModel = catalog.model.toLowerCase().startsWith(catalog.brand.toLowerCase())
        ? catalog.model
        : `${catalog.brand} ${catalog.model}`;
    return `${catalog.type} ${brandModel} - ${linePrefix} ${lineNo}`;
};

const rows = Array.from({ length: 1020 }, (_, zeroIndex) => {
    const index = zeroIndex + 1;
    const catalog = catalogs[zeroIndex % catalogs.length];
    const plant = plants[(zeroIndex + Math.floor(zeroIndex / 7)) % plants.length];
    const area = plant.areas[(zeroIndex * 2) % plant.areas.length];
    const status = statusSequence[zeroIndex % statusSequence.length];
    const linePrefix = catalog.linePrefixes[zeroIndex % catalog.linePrefixes.length];
    const purchaseDate = toPurchaseDate(index);
    const purchaseYear = purchaseDate.slice(0, 4);
    const lineNo = String((zeroIndex % 24) + 1).padStart(2, '0');

    return {
        name: toAssetName(catalog, linePrefix, lineNo),
        machineCode: toMachineCode(index),
        serial_number: toSerial(catalog, index, purchaseYear),
        type: catalog.type,
        model: catalog.model,
        brand: catalog.brand,
        plantCode: plant.code,
        area,
        status,
        purchaseDate,
        purchasePrice: toPurchasePrice(catalog, index),
        note: toNote(status, plant.code, linePrefix),
    };
});

const workbook = XLSX.utils.book_new();

const templateSheet = XLSX.utils.json_to_sheet(rows, {
    header: [
        'name',
        'machineCode',
        'serial_number',
        'type',
        'model',
        'brand',
        'plantCode',
        'area',
        'status',
        'purchaseDate',
        'purchasePrice',
        'note',
    ],
});

templateSheet['!freeze'] = { xSplit: 0, ySplit: 1 };
templateSheet['!autofilter'] = { ref: 'A1:L1021' };
templateSheet['!cols'] = [
    { wch: 46 },
    { wch: 14 },
    { wch: 30 },
    { wch: 24 },
    { wch: 22 },
    { wch: 12 },
    { wch: 12 },
    { wch: 28 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 42 },
];

const referenceRows = [
    ['Field', 'Required', 'Accepted Header', 'Example / Notes'],
    ['name', 'Yes', 'name', 'May 1 kim dien tu Juki DDL-8000A - Ao Polo 01'],
    ['machineCode', 'Yes', 'machineCode', 'Unique. Example: IMP00001'],
    ['serial', 'No', 'serial_number', 'serial_number is accepted because the importer normalizes it to serial'],
    ['type', 'Yes', 'type', 'Machine category. Example: May 1 kim dien tu'],
    ['model', 'Yes', 'model', 'Exact machine model. Example: Juki DDL-8000A'],
    ['brand', 'Yes', 'brand', 'Must exist in DB. Seed-safe values: Juki, Brother, Jack, Siruba, Pegasus'],
    ['plantCode', 'Yes', 'plantCode', 'Must exist in DB. Seed-safe values: BD01, HCM01, KHO01'],
    ['area', 'No', 'area', 'Current schema location field. Use area, not location, for direct import'],
    ['status', 'No', 'status', 'Allowed: active, maintenance, broken, borrowing, storage'],
    ['purchaseDate', 'No', 'purchaseDate', 'YYYY-MM-DD'],
    ['purchasePrice', 'No', 'purchasePrice', 'Number only'],
    ['note', 'No', 'note', 'Free text'],
    [],
    ['Valid Plants', '', '', ''],
    ['BD01', '', 'Nha may Binh Duong', ''],
    ['HCM01', '', 'Nha may HCM', ''],
    ['KHO01', '', 'Kho tong phu lieu va may du phong', ''],
    [],
    ['Valid Brands', '', '', ''],
    ['Juki', '', '', ''],
    ['Brother', '', '', ''],
    ['Jack', '', '', ''],
    ['Siruba', '', '', ''],
    ['Pegasus', '', '', ''],
];

const referenceSheet = XLSX.utils.aoa_to_sheet(referenceRows);
referenceSheet['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 20 }, { wch: 72 }];

XLSX.utils.book_append_sheet(workbook, templateSheet, 'machine_import_template');
XLSX.utils.book_append_sheet(workbook, referenceSheet, 'reference');

await fs.mkdir(outputDir, { recursive: true });
XLSX.writeFile(workbook, outputPath);

console.log(JSON.stringify({ outputPath, rowCount: rows.length, firstRow: rows[0], lastRow: rows.at(-1) }, null, 2));
