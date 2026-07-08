/**
 * TỔNG VỆ SINH DỮ LIỆU — BƯỚC 2: APPLY (ghi DB theo file Excel đã duyệt)
 *
 * Chỉ áp dụng các dòng có "x" ở cột Duyệt trong file do data-cleanup-dry-run.mjs xuất ra.
 * Trước khi ghi bất cứ gì, toàn bộ giá trị cũ được lưu vào file undo JSON — có thể hoàn tác.
 *
 * Cách chạy (PowerShell, trong thư mục BE):
 *   node scripts/data-cleanup-apply.mjs --file tmp/data-cleanup-2026-07-08.xlsx          # xem trước (không ghi)
 *   node scripts/data-cleanup-apply.mjs --file tmp/data-cleanup-2026-07-08.xlsx --yes    # ghi thật
 *   node scripts/data-cleanup-apply.mjs --undo tmp/data-cleanup-undo-<stamp>.json --yes  # hoàn tác
 *
 * ⚠️  Chạy --yes trên PROD chỉ sau khi đã có backup (cron GCS 2h sáng hằng ngày — kiểm tra bản mới nhất).
 *
 * Env: MONGODB_URL_DEV + MONGODB_DB_NAME trong .env (giống dry-run).
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import ExcelJS from 'exceljs';

// Snapshot doc giữ nguyên ObjectId/Date khi ghi ra JSON (undo restore không bị biến thành string)
const snapshot = (doc) => EJSON.serialize(doc, { relaxed: false });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BE_ROOT = path.resolve(__dirname, '..');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const confirmed = process.argv.includes('--yes');
const excelFile = arg('file');
const undoFile = arg('undo');

const mongoUrl = process.env.MONGODB_URL_DEV || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'device-management';
if (!mongoUrl) {
    console.error('[apply] Thiếu MONGODB_URL_DEV trong .env');
    process.exit(1);
}
if (!excelFile && !undoFile) {
    console.error('[apply] Dùng: --file <file.xlsx> hoặc --undo <undo.json>');
    process.exit(1);
}

const maskedHost = mongoUrl.replace(/\/\/[^@]+@/, '//***@').split('?')[0];
console.log(`[apply] DB: "${dbName}" @ ${maskedHost}  (ghi thật: ${confirmed ? 'CÓ' : 'không — xem trước'})`);

await mongoose.connect(mongoUrl, { dbName });
const col = (name) => mongoose.connection.collection(name);
const oid = (s) => new mongoose.Types.ObjectId(String(s));

// ─── Chế độ UNDO ───────────────────────────────────────────────────────────

if (undoFile) {
    const entries = JSON.parse(fs.readFileSync(undoFile, 'utf-8'));
    console.log(`[undo] ${entries.length} mục trong file undo.`);
    let done = 0;
    for (const e of entries) {
        if (!confirmed) continue;
        if (e.type === 'field-bulk') {
            await col(e.collection).updateMany(
                { _id: { $in: e.ids.map(oid) } },
                { $set: { [e.field]: e.oldValue } }
            );
        } else if (e.type === 'field-each') {
            for (const it of e.items) {
                await col(e.collection).updateOne({ _id: oid(it.id) }, { $set: it.old });
            }
        } else if (e.type === 'doc') {
            const { _id, ...rest } = EJSON.deserialize(e.doc, { relaxed: false });
            await col(e.collection).replaceOne({ _id }, rest, { upsert: true });
        }
        done++;
    }
    console.log(confirmed ? `[undo] ✅ Hoàn tác ${done} mục.` : '[undo] Xem trước xong — thêm --yes để hoàn tác thật.');
    await mongoose.disconnect();
    process.exit(0);
}

// ─── Đọc file Excel đã duyệt ───────────────────────────────────────────────

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(excelFile);
const cellText = (row, idx) => {
    const v = row.getCell(idx).value;
    if (v == null) return '';
    if (typeof v === 'object' && 'result' in v) return String(v.result ?? '').trim();
    if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('').trim();
    return String(v).trim();
};
const isApproved = (s) => s.toLowerCase() === 'x';

const readSheet = (name, mapRow) => {
    const ws = wb.getWorksheet(name);
    if (!ws) return [];
    const rows = [];
    ws.eachRow((row, n) => {
        if (n === 1) return;
        const r = mapRow(row);
        if (r) rows.push(r);
    });
    return rows;
};

const typeRows = readSheet('TYPE', (row) => ({
    raw: cellText(row, 1),
    canonical: cellText(row, 3),
    approve: isApproved(cellText(row, 6)),
}));
const modelRows = readSheet('MODEL', (row) => ({
    machineCode: cellText(row, 1),
    model: cellText(row, 4),
    approve: isApproved(cellText(row, 6)),
}));
const priceRows = readSheet('PRICE', (row) => ({
    machineCode: cellText(row, 1),
    price: Number(cellText(row, 4).replace(/[^\d]/g, '')),
    approve: isApproved(cellText(row, 7)),
}));
const materialRows = readSheet('MATERIAL', (row) => ({
    group: cellText(row, 1),
    action: cellText(row, 2).toUpperCase(),
    materialId: cellText(row, 3),
    name: cellText(row, 4),
    approve: isApproved(cellText(row, 9)),
}));

const approvedTypes = typeRows.filter((r) => r.approve && r.raw && r.canonical);
const approvedModels = modelRows.filter((r) => r.approve && r.machineCode && r.model);
const approvedPrices = priceRows.filter((r) => r.approve && r.machineCode && r.price > 0);

// Gom nhóm vật tư: mỗi nhóm cần đúng 1 dòng GIỮ; các dòng GỘP có duyệt sẽ gộp vào đó
const matGroups = new Map();
for (const r of materialRows) {
    if (!r.materialId) continue;
    if (!matGroups.has(r.group)) matGroups.set(r.group, { keep: null, merge: [] });
    const g = matGroups.get(r.group);
    if (r.action === 'GIỮ') g.keep = r;
    else if (r.action === 'GỘP' && r.approve) g.merge.push(r);
}
const mergePlans = [...matGroups.values()].filter((g) => g.keep && g.merge.length);

console.log(`\n[apply] Sẽ áp dụng:`);
console.log(`  • TYPE   : ${approvedTypes.length} giá trị loại máy`);
console.log(`  • MODEL  : ${approvedModels.length} máy`);
console.log(`  • PRICE  : ${approvedPrices.length} máy (giá ước tính, ghi chú kèm dấu vết)`);
console.log(`  • MATERIAL: ${mergePlans.reduce((s, g) => s + g.merge.length, 0)} vật tư gộp vào ${mergePlans.length} nhóm`);

if (!confirmed) {
    console.log('\n[apply] Xem trước xong — thêm --yes để ghi thật. (Nhớ chắc chắn đã có backup GCS mới nhất!)');
    await mongoose.disconnect();
    process.exit(0);
}

const undo = [];
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// ─── 1. TYPE ───────────────────────────────────────────────────────────────

for (const r of approvedTypes) {
    const filter = r.raw === '(trống)' ? { $or: [{ type: '' }, { type: null }], isDeleted: { $ne: true } } : { type: r.raw, isDeleted: { $ne: true } };
    const affected = await col('assets').find(filter).project({ _id: 1 }).toArray();
    if (!affected.length) continue;
    undo.push({
        type: 'field-bulk',
        collection: 'assets',
        field: 'type',
        oldValue: r.raw === '(trống)' ? '' : r.raw,
        ids: affected.map((d) => String(d._id)),
    });
    await col('assets').updateMany(filter, { $set: { type: r.canonical } });
    console.log(`[apply] TYPE "${r.raw}" → "${r.canonical}" (${affected.length} máy)`);
}

// ─── 2. MODEL ──────────────────────────────────────────────────────────────

if (approvedModels.length) {
    const each = [];
    for (const r of approvedModels) {
        const doc = await col('assets').findOne({ machineCode: r.machineCode });
        if (!doc) {
            console.warn(`[apply] MODEL bỏ qua — không thấy máy ${r.machineCode}`);
            continue;
        }
        each.push({ id: String(doc._id), old: { model: doc.model ?? null } });
        await col('assets').updateOne({ _id: doc._id }, { $set: { model: r.model } });
    }
    undo.push({ type: 'field-each', collection: 'assets', items: each });
    console.log(`[apply] MODEL cập nhật ${each.length} máy`);
}

// ─── 3. PRICE ──────────────────────────────────────────────────────────────

if (approvedPrices.length) {
    const each = [];
    const tag = `[Giá ước tính theo trung vị máy cùng model — ${new Date().toISOString().slice(0, 10)}]`;
    for (const r of approvedPrices) {
        const doc = await col('assets').findOne({ machineCode: r.machineCode });
        if (!doc) {
            console.warn(`[apply] PRICE bỏ qua — không thấy máy ${r.machineCode}`);
            continue;
        }
        if (doc.purchasePrice > 0) {
            console.warn(`[apply] PRICE bỏ qua ${r.machineCode} — đã có giá thật từ lúc dry-run`);
            continue;
        }
        each.push({ id: String(doc._id), old: { purchasePrice: doc.purchasePrice ?? null, note: doc.note ?? null } });
        const note = doc.note ? `${doc.note}\n${tag}` : tag;
        await col('assets').updateOne({ _id: doc._id }, { $set: { purchasePrice: r.price, note } });
    }
    undo.push({ type: 'field-each', collection: 'assets', items: each });
    console.log(`[apply] PRICE điền giá ước tính cho ${each.length} máy`);
}

// ─── 4. MATERIAL merge ─────────────────────────────────────────────────────
// Trỏ mọi tham chiếu materialId (cả field gốc lẫn trong mảng items) từ bản GỘP về bản GIỮ,
// cộng tồn kho theo từng cơ sở, rồi soft-delete bản GỘP.

const REF_COLLECTIONS = [
    'stocktransactions',
    'distributionrecords',
    'purchaserequests',
    'purchaseorders',
    'purchaseshortages',
    'supplyshortages',
    'returnrecords',
];

for (const g of mergePlans) {
    const keepId = oid(g.keep.materialId);
    const keepDoc = await col('materials').findOne({ _id: keepId });
    if (!keepDoc) {
        console.warn(`[apply] MATERIAL bỏ qua nhóm — không thấy bản GIỮ ${g.keep.materialId}`);
        continue;
    }
    for (const m of g.merge) {
        const dupId = oid(m.materialId);
        const dupDoc = await col('materials').findOne({ _id: dupId });
        if (!dupDoc) {
            console.warn(`[apply] MATERIAL bỏ qua — không thấy ${m.materialId}`);
            continue;
        }

        // 4a. Tham chiếu ở các collection nghiệp vụ — lưu nguyên bản gốc vào undo rồi trỏ lại
        for (const cname of REF_COLLECTIONS) {
            const c = col(cname);
            const affected = await c
                .find({ $or: [{ materialId: dupId }, { 'items.materialId': dupId }] })
                .toArray();
            for (const doc of affected) undo.push({ type: 'doc', collection: cname, doc: snapshot(doc) });
            if (!affected.length) continue;
            await c.updateMany({ materialId: dupId }, { $set: { materialId: keepId } });
            await c.updateMany(
                { 'items.materialId': dupId },
                { $set: { 'items.$[it].materialId': keepId } },
                { arrayFilters: [{ 'it.materialId': dupId }] }
            );
        }

        // 4b. Tồn kho: cộng dồn vào dòng của bản GIỮ theo từng cơ sở
        const dupStocks = await col('inventorystocks').find({ materialId: dupId }).toArray();
        for (const ds of dupStocks) {
            undo.push({ type: 'doc', collection: 'inventorystocks', doc: snapshot(ds) });
            const keepStock = await col('inventorystocks').findOne({ materialId: keepId, plantId: ds.plantId });
            if (keepStock) {
                undo.push({ type: 'doc', collection: 'inventorystocks', doc: snapshot(keepStock) });
                await col('inventorystocks').updateOne(
                    { _id: keepStock._id },
                    { $inc: { currentStock: ds.currentStock || 0 } }
                );
                await col('inventorystocks').deleteOne({ _id: ds._id });
            } else {
                await col('inventorystocks').updateOne({ _id: ds._id }, { $set: { materialId: keepId } });
            }
        }

        // 4c. Soft-delete bản GỘP, ghi dấu vết
        undo.push({ type: 'doc', collection: 'materials', doc: snapshot(dupDoc) });
        await col('materials').updateOne(
            { _id: dupId },
            {
                $set: {
                    isDeleted: true,
                    isActive: false,
                    deletedAt: new Date(),
                    description: `${dupDoc.description ? dupDoc.description + ' — ' : ''}[Đã gộp vào "${keepDoc.name}" khi tổng vệ sinh dữ liệu]`,
                },
            }
        );
        console.log(`[apply] MATERIAL "${dupDoc.name}" → gộp vào "${keepDoc.name}"`);
    }
}

// ─── Ghi undo + tổng kết ───────────────────────────────────────────────────

const undoPath = path.join(BE_ROOT, 'tmp', `data-cleanup-undo-${stamp}.json`);
fs.mkdirSync(path.dirname(undoPath), { recursive: true });
fs.writeFileSync(undoPath, JSON.stringify(undo, null, 1));

console.log(`\n[apply] ✅ Xong. File hoàn tác: ${undoPath}`);
console.log(`[apply] Hoàn tác nếu cần:  node scripts/data-cleanup-apply.mjs --undo "${undoPath}" --yes`);

await mongoose.disconnect();
