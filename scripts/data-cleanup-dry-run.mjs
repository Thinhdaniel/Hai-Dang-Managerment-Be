/**
 * TỔNG VỆ SINH DỮ LIỆU — BƯỚC 1: DRY-RUN (chỉ đọc DB, KHÔNG ghi gì)
 *
 * Rà toàn bộ dữ liệu cũ và xuất file Excel đề xuất để người duyệt:
 *   Sheet TYPE      — chuẩn hóa loại máy (1k / M1K / "may 1 kim" → 1 loại chuẩn)  [AI]
 *   Sheet MODEL     — bóc model từ tên máy cho máy có model rác (model = type)     [AI]
 *   Sheet PRICE     — ước tính giá mua từ trung vị máy cùng nhãn hiệu + model      [thuật toán]
 *   Sheet MATERIAL  — gộp vật tư trùng tên/đơn vị                                  [AI]
 *   Sheet BAO-CAO   — danh sách cần người xử lý (thiếu serial, thiếu ảnh, nghi trùng máy)
 *
 * Cách chạy (PowerShell, trong thư mục BE):
 *   node scripts/data-cleanup-dry-run.mjs                # đầy đủ
 *   node scripts/data-cleanup-dry-run.mjs --skip-ai      # chỉ phần thuật toán + báo cáo
 *
 * Env cần trong .env (giống script backfill cũ):
 *   MONGODB_URL_DEV=mongodb+srv://...   (trỏ PROD khi chạy thật — script sẽ in tên DB để kiểm tra)
 *   MONGODB_DB_NAME=device-management
 *   VERTEX_PROXY_URL=... / VERTEX_PROXY_KEY=...   (copy từ Render → Environment nếu local chưa có)
 *
 * Sau khi duyệt file Excel (cột "Duyệt": x = đồng ý, xóa x = bỏ):
 *   node scripts/data-cleanup-apply.mjs --file tmp/data-cleanup-<ngày>.xlsx
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BE_ROOT = path.resolve(__dirname, '..');

const skipAi = process.argv.includes('--skip-ai');
const mongoUrl = process.env.MONGODB_URL_DEV || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'device-management';
const vertexUrl = (process.env.VERTEX_PROXY_URL || '').replace(/\/+$/, '');
const vertexKey = process.env.VERTEX_PROXY_KEY || '';
const AI_MODEL = process.env.CLEANUP_AI_MODEL || 'gemini-2.5-pro';

if (!mongoUrl) {
    console.error('[cleanup] Thiếu MONGODB_URL_DEV trong .env');
    process.exit(1);
}
if (!skipAi && (!vertexUrl || !vertexKey)) {
    console.error('[cleanup] Thiếu VERTEX_PROXY_URL / VERTEX_PROXY_KEY trong .env (copy từ Render → Environment).');
    console.error('          Hoặc chạy với --skip-ai để bỏ qua các phần cần AI.');
    process.exit(1);
}

const maskedHost = mongoUrl.replace(/\/\/[^@]+@/, '//***@').split('?')[0];
console.log(`[cleanup] DB: "${dbName}" @ ${maskedHost}`);
if (dbName !== 'device-management') {
    console.warn(`[cleanup] ⚠️  DB name khác 'device-management' — kiểm tra lại có đúng PROD không!`);
}

await mongoose.connect(mongoUrl, { dbName });
const col = (name) => mongoose.connection.collection(name);

// ─── Helpers ───────────────────────────────────────────────────────────────

const stripDiacritics = (s) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D');

const normName = (s) => stripDiacritics(s).toLowerCase().replace(/\s+/g, ' ').trim();

const median = (nums) => {
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Bóc JSON object đầu tiên khỏi trả lời AI (chịu được ```json fence, chữ thừa 2 đầu)
const extractJson = (text) => {
    const cleaned = String(text).replace(/```(?:json)?/gi, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI không trả về JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
};

// Gọi vertex-proxy /generate — reasoningEffort 'low' để Gemini không đốt token thinking làm cụt JSON
const callAi = async ({ system, prompt, maxOutputTokens = 16384 }) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await fetch(`${vertexUrl}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-vertex-proxy-key': vertexKey },
                body: JSON.stringify({
                    system,
                    prompt,
                    model: AI_MODEL,
                    temperature: 0.1,
                    maxOutputTokens,
                    json: true,
                    reasoningEffort: 'low',
                }),
                signal: AbortSignal.timeout(180000),
            });
            if (!res.ok) throw new Error(`Vertex proxy HTTP ${res.status}`);
            const data = await res.json();
            if (!data.content) throw new Error(data.error || 'Vertex trả về rỗng');
            return extractJson(data.content);
        } catch (e) {
            console.warn(`[cleanup]   AI lỗi (lần ${attempt}/2): ${e.message}`);
            if (attempt === 2) throw e;
        }
    }
};

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

// ─── Nạp dữ liệu ───────────────────────────────────────────────────────────

const assets = await col('assets').find({ isDeleted: { $ne: true } }).toArray();
const brands = await col('brands').find({}).toArray();
const plants = await col('plants').find({}).toArray();
const brandName = new Map(brands.map((b) => [String(b._id), b.name]));
const plantName = new Map(plants.map((p) => [String(p._id), p.name]));
console.log(`[cleanup] Nạp ${assets.length} máy, ${brands.length} nhãn hiệu, ${plants.length} cơ sở.`);

// ─── PHẦN 1: Chuẩn hóa TYPE ────────────────────────────────────────────────

console.log('\n[cleanup] ── 1/5 Chuẩn hóa loại máy (type) ──');
const typeGroups = new Map(); // rawType -> { count, samples[] }
for (const a of assets) {
    const raw = (a.type || '').trim() || '(trống)';
    if (!typeGroups.has(raw)) typeGroups.set(raw, { count: 0, samples: [] });
    const g = typeGroups.get(raw);
    g.count++;
    if (g.samples.length < 3) g.samples.push(`${a.name}${a.model && a.model !== a.type ? ` — ${a.model}` : ''}`);
}
console.log(`[cleanup] ${typeGroups.size} giá trị type khác nhau trên ${assets.length} máy.`);

let typeRows = [];
if (!skipAi) {
    const typeList = [...typeGroups.entries()].map(([raw, g]) => ({ raw, count: g.count, samples: g.samples }));
    const typeSystem = `Bạn là chuyên gia chuẩn hóa dữ liệu thiết bị nhà máy MAY MẶC tại Việt Nam.
Nhiệm vụ: gom các giá trị "loại máy" nhập tay lộn xộn về một bộ loại chuẩn.
Quy tắc bộ loại chuẩn:
- Tên tiếng Việt CÓ DẤU, ngắn gọn, viết hoa chữ cái đầu. Ví dụ: "Máy 1 kim", "Máy 2 kim", "Máy vắt sổ 4 chỉ", "Máy vắt sổ 5 chỉ", "Máy đính bọ", "Máy thùa khuy", "Máy cắt vải", "Bàn là hơi", "Nồi hơi", "Máy kansai", "Máy trần đè".
- TUYỆT ĐỐI không tạo 2 loại chuẩn đồng nghĩa (vd "Máy 1 kim" và "Máy may 1 kim" phải là một).
- Dựa vào cả tên máy mẫu (samples) để suy loại; "1k"/"M1K" với sample "Máy may 1 kim..." → "Máy 1 kim".
- Không chắc chắn thì canonical = "KHÔNG RÕ" và confidence = "low". Không được đoán bừa.
Trả về JSON đúng schema: {"mapping":[{"raw":"...","canonical":"...","confidence":"high|medium|low"}]} — mapping phải đủ MỌI giá trị raw được đưa vào, không thêm không bớt.`;

    const mapping = new Map();
    for (const [i, part] of chunk(typeList, 200).entries()) {
        console.log(`[cleanup]   Gọi AI map type — lô ${i + 1}...`);
        const out = await callAi({ system: typeSystem, prompt: JSON.stringify(part) });
        for (const m of out.mapping || []) {
            if (m?.raw != null && m?.canonical) mapping.set(String(m.raw), m);
        }
    }
    for (const [raw, g] of typeGroups.entries()) {
        const m = mapping.get(raw);
        typeRows.push({
            raw,
            count: g.count,
            samples: g.samples.join(' | '),
            canonical: m?.canonical || 'KHÔNG RÕ',
            confidence: m?.confidence || 'low',
            approve: m && m.confidence === 'high' && m.canonical !== 'KHÔNG RÕ' && m.canonical !== raw ? 'x' : '',
            noChange: m?.canonical === raw,
        });
    }
    typeRows = typeRows.filter((r) => !r.noChange).sort((a, b) => b.count - a.count);
    console.log(`[cleanup]   → ${typeRows.length} giá trị type cần đổi.`);
} else {
    console.log('[cleanup]   (bỏ qua — --skip-ai)');
}

// ─── PHẦN 2: Bóc MODEL từ tên máy ──────────────────────────────────────────
// Schema cũ default model = type nên rất nhiều máy có model rác. Chỉ xử lý nhóm đó.

console.log('\n[cleanup] ── 2/5 Bóc model từ tên máy ──');
const junkModel = (a) => {
    const m = (a.model || '').trim();
    return !m || normName(m) === normName(a.type || '');
};
const needModel = assets.filter(junkModel);
console.log(`[cleanup] ${needModel.length} máy có model rác (trống hoặc = type).`);

let modelRows = [];
if (!skipAi && needModel.length) {
    const modelSystem = `Bạn nhận danh sách máy may công nghiệp. Với mỗi máy, tìm MÃ MODEL của hãng nếu nó xuất hiện RÕ RÀNG trong tên máy.
Ví dụ: "Máy may 1 kim điện tử Juki DDL-8000A" → model "DDL-8000A". "Máy vắt sổ Siruba 747" → "747".
Quy tắc: CHỈ lấy khi mã model thực sự nằm trong tên; tên chung chung như "Máy may 1 kim" → model null. Không được bịa.
Trả JSON: {"items":[{"i":<số thứ tự>,"model":"..."|null}]} — đủ mọi i được đưa vào.`;

    const items = needModel.map((a, i) => ({
        i,
        name: a.name,
        brand: brandName.get(String(a.brandId)) || '',
    }));
    const found = new Map();
    for (const [ci, part] of chunk(items, 80).entries()) {
        console.log(`[cleanup]   Gọi AI bóc model — lô ${ci + 1}/${Math.ceil(items.length / 80)}...`);
        const out = await callAi({ system: modelSystem, prompt: JSON.stringify(part) });
        for (const it of out.items || []) {
            if (it && Number.isInteger(it.i) && it.model && String(it.model).trim()) {
                found.set(it.i, String(it.model).trim());
            }
        }
    }
    modelRows = [...found.entries()].map(([i, model]) => {
        const a = needModel[i];
        // Guard chống ảo giác: model đề xuất phải thực sự xuất hiện trong tên máy (bỏ dấu, bỏ hoa thường)
        const inName = normName(a.name).includes(normName(model));
        return {
            machineCode: a.machineCode,
            name: a.name,
            oldModel: a.model || '',
            model,
            approve: inName ? 'x' : '',
            note: inName ? '' : '⚠️ không thấy trong tên — tự kiểm tra',
        };
    });
    console.log(`[cleanup]   → bóc được model cho ${modelRows.length}/${needModel.length} máy.`);
} else {
    console.log('[cleanup]   (bỏ qua)');
}

// ─── PHẦN 3: Ước tính giá mua từ trung vị cùng nhãn + model ────────────────

console.log('\n[cleanup] ── 3/5 Ước tính giá mua ──');
const proposedModel = new Map(modelRows.map((r) => [r.machineCode, r.model]));
const modelKey = (a) => {
    const m = proposedModel.get(a.machineCode) || (!junkModel(a) ? a.model.trim() : '');
    return m ? `${String(a.brandId)}::${normName(m)}` : null;
};
const priced = new Map(); // key -> số[]
for (const a of assets) {
    const k = modelKey(a);
    if (k && a.purchasePrice > 0) {
        if (!priced.has(k)) priced.set(k, []);
        priced.get(k).push(a.purchasePrice);
    }
}
const priceRows = [];
let noEstimate = 0;
for (const a of assets) {
    if (a.purchasePrice > 0) continue;
    const k = modelKey(a);
    const samples = k ? priced.get(k) : undefined;
    if (samples && samples.length >= 2) {
        priceRows.push({
            machineCode: a.machineCode,
            name: a.name,
            model: proposedModel.get(a.machineCode) || a.model || '',
            price: median(samples),
            sampleCount: samples.length,
            range: `${Math.min(...samples).toLocaleString('vi')} – ${Math.max(...samples).toLocaleString('vi')}`,
            approve: 'x',
        });
    } else {
        noEstimate++;
    }
}
console.log(`[cleanup] Ước tính được giá cho ${priceRows.length} máy; ${noEstimate} máy không đủ mẫu (vào báo cáo).`);

// ─── PHẦN 4: Gộp vật tư trùng ──────────────────────────────────────────────

console.log('\n[cleanup] ── 4/5 Vật tư trùng ──');
const materials = await col('materials').find({ isDeleted: { $ne: true } }).toArray();
const stockAgg = await col('inventorystocks')
    .aggregate([{ $group: { _id: '$materialId', stock: { $sum: '$currentStock' } } }])
    .toArray();
const txAgg = await col('stocktransactions')
    .aggregate([{ $group: { _id: '$materialId', tx: { $sum: 1 } } }])
    .toArray();
const stockOf = new Map(stockAgg.map((s) => [String(s._id), s.stock]));
const txOf = new Map(txAgg.map((t) => [String(t._id), t.tx]));
console.log(`[cleanup] ${materials.length} vật tư đang hoạt động.`);

let materialRows = [];
if (!skipAi && materials.length) {
    const matSystem = `Bạn nhận danh sách vật tư/phụ tùng của xưởng may (id, tên, đơn vị).
Tìm các NHÓM vật tư thực chất là MỘT thứ nhưng bị tạo nhiều bản ghi do gõ khác nhau (sai chính tả, viết tắt, có/không dấu).
Ví dụ nhóm: "Dầu máy may" / "dau may" / "Dầu bôi trơn máy may" (cùng lít).
Quy tắc: CHỈ gom khi rất chắc chắn là cùng một mặt hàng và đơn vị tính tương đương. Kim DB x 90 và kim DB x 75 là 2 thứ KHÁC nhau. Nghi ngờ thì bỏ qua.
Trả JSON: {"groups":[[i,i,...],...]} — mỗi group là mảng chỉ số i của các vật tư trùng nhau (≥2 phần tử).`;

    const matItems = materials.map((m, i) => ({ i, name: m.name, unit: m.unit }));
    const out = await callAi({ system: matSystem, prompt: JSON.stringify(matItems) });
    let groupNo = 0;
    for (const g of out.groups || []) {
        const members = (Array.isArray(g) ? g : []).filter((i) => Number.isInteger(i) && materials[i]);
        if (members.length < 2) continue;
        groupNo++;
        // Giữ lại bản ghi được dùng nhiều nhất (nhiều giao dịch kho nhất), hòa thì lấy bản cũ nhất
        const sorted = [...members].sort((a, b) => {
            const ta = txOf.get(String(materials[a]._id)) || 0;
            const tb = txOf.get(String(materials[b]._id)) || 0;
            if (tb !== ta) return tb - ta;
            return new Date(materials[a].createdAt || 0) - new Date(materials[b].createdAt || 0);
        });
        const keepMat = materials[sorted[0]];
        for (const [rank, i] of sorted.entries()) {
            const m = materials[i];
            // Chỉ tự tick x khi tên chuẩn hóa GIỐNG HỆT bản giữ (trùng thuần do gõ hoa/thường/dấu).
            // AI hay gộp ẩu kim khác cỡ / model khác nhau — mấy ca đó bắt buộc người duyệt tay.
            const safeDup = normName(m.name) === normName(keepMat.name);
            materialRows.push({
                group: groupNo,
                action: rank === 0 ? 'GIỮ' : 'GỘP',
                materialId: String(m._id),
                name: m.name,
                code: m.code || '',
                unit: m.unit,
                stock: stockOf.get(String(m._id)) || 0,
                tx: txOf.get(String(m._id)) || 0,
                approve: rank === 0 ? '' : safeDup ? 'x' : '',
            });
        }
    }
    console.log(`[cleanup]   → ${groupNo} nhóm nghi trùng.`);
} else {
    console.log('[cleanup]   (bỏ qua)');
}

// ─── PHẦN 5: Báo cáo cần người xử lý ───────────────────────────────────────

console.log('\n[cleanup] ── 5/5 Báo cáo cần người ──');
const activeStatuses = ['active', 'in_maintenance', 'inactive'];
const activeAssets = assets.filter((a) => activeStatuses.includes(a.status));
const missingSerial = activeAssets.filter((a) => !(a.serial || '').trim());
const missingImage = activeAssets.filter((a) => !(a.imageUrl || '').trim());
const dupCandidates = [];
{
    const byKey = new Map();
    for (const a of activeAssets) {
        const k = `${String(a.plantId)}::${normName(a.name)}::${normName(a.model || '')}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(a);
    }
    for (const group of byKey.values()) {
        const noSerial = group.filter((a) => !(a.serial || '').trim());
        if (group.length > 1 && noSerial.length >= 2) dupCandidates.push(group);
    }
}
console.log(
    `[cleanup] Thiếu serial: ${missingSerial.length} | thiếu ảnh: ${missingImage.length} | nhóm nghi trùng hồ sơ máy: ${dupCandidates.length}`
);

// ─── Xuất Excel ────────────────────────────────────────────────────────────

const wb = new ExcelJS.Workbook();
const headerStyle = (ws) => {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
};

const wsInfo = wb.addWorksheet('HƯỚNG DẪN');
wsInfo.addRows([
    ['TỔNG VỆ SINH DỮ LIỆU — file đề xuất, CHƯA ghi gì vào hệ thống'],
    [''],
    ['Cách duyệt: cột "Duyệt" có chữ x = sẽ áp dụng. Xóa x ở dòng nào thì dòng đó bị bỏ qua.'],
    ['Dòng confidence "low/medium" mặc định KHÔNG có x — mày xem ok thì tự điền x.'],
    ['Sheet MATERIAL: dòng GIỮ là bản được giữ lại, dòng GỘP có x sẽ bị gộp vào dòng GIỮ cùng nhóm.'],
    ['Muốn đổi bản giữ lại: sửa chữ GIỮ/GỘP giữa 2 dòng trong cùng nhóm.'],
    [''],
    ['Duyệt xong chạy:  node scripts/data-cleanup-apply.mjs --file <đường dẫn file này>'],
    [''],
    ['Tóm tắt:'],
    [`  • TYPE: ${typeRows.length} giá trị loại máy cần chuẩn hóa`],
    [`  • MODEL: ${modelRows.length} máy bóc được model từ tên`],
    [`  • PRICE: ${priceRows.length} máy ước tính được giá mua (ghi kèm dấu [ước tính] vào ghi chú)`],
    [`  • MATERIAL: ${materialRows.length ? materialRows.filter((r) => r.action === 'GỘP').length : 0} vật tư đề xuất gộp`],
    [`  • Cần người: ${missingSerial.length} máy thiếu serial, ${missingImage.length} thiếu ảnh, ${dupCandidates.length} nhóm nghi trùng hồ sơ`],
]);
wsInfo.getColumn(1).width = 110;
wsInfo.getRow(1).font = { bold: true, size: 14 };

const wsType = wb.addWorksheet('TYPE');
wsType.columns = [
    { header: 'Type hiện tại', key: 'raw', width: 28 },
    { header: 'Số máy', key: 'count', width: 8 },
    { header: 'Đề xuất chuẩn', key: 'canonical', width: 28 },
    { header: 'Độ tin', key: 'confidence', width: 10 },
    { header: 'Máy mẫu', key: 'samples', width: 70 },
    { header: 'Duyệt', key: 'approve', width: 8 },
];
wsType.addRows(typeRows);
headerStyle(wsType);

const wsModel = wb.addWorksheet('MODEL');
wsModel.columns = [
    { header: 'Mã máy', key: 'machineCode', width: 22 },
    { header: 'Tên máy', key: 'name', width: 50 },
    { header: 'Model cũ', key: 'oldModel', width: 20 },
    { header: 'Model đề xuất', key: 'model', width: 20 },
    { header: 'Ghi chú', key: 'note', width: 30 },
    { header: 'Duyệt', key: 'approve', width: 8 },
];
wsModel.addRows(modelRows);
headerStyle(wsModel);

const wsPrice = wb.addWorksheet('PRICE');
wsPrice.columns = [
    { header: 'Mã máy', key: 'machineCode', width: 22 },
    { header: 'Tên máy', key: 'name', width: 50 },
    { header: 'Model', key: 'model', width: 20 },
    { header: 'Giá đề xuất (trung vị)', key: 'price', width: 20, style: { numFmt: '#,##0' } },
    { header: 'Số máy mẫu', key: 'sampleCount', width: 12 },
    { header: 'Khoảng giá mẫu', key: 'range', width: 28 },
    { header: 'Duyệt', key: 'approve', width: 8 },
];
wsPrice.addRows(priceRows);
headerStyle(wsPrice);

const wsMat = wb.addWorksheet('MATERIAL');
wsMat.columns = [
    { header: 'Nhóm', key: 'group', width: 8 },
    { header: 'GIỮ/GỘP', key: 'action', width: 10 },
    { header: 'materialId', key: 'materialId', width: 26 },
    { header: 'Tên vật tư', key: 'name', width: 45 },
    { header: 'Mã', key: 'code', width: 14 },
    { header: 'Đơn vị', key: 'unit', width: 10 },
    { header: 'Tồn', key: 'stock', width: 10 },
    { header: 'Giao dịch', key: 'tx', width: 10 },
    { header: 'Duyệt', key: 'approve', width: 8 },
];
wsMat.addRows(materialRows);
headerStyle(wsMat);

const wsReport = wb.addWorksheet('BAO-CAO');
wsReport.columns = [
    { header: 'Vấn đề', key: 'issue', width: 24 },
    { header: 'Mã máy', key: 'machineCode', width: 22 },
    { header: 'Tên máy', key: 'name', width: 50 },
    { header: 'Cơ sở', key: 'plant', width: 20 },
    { header: 'Chi tiết', key: 'detail', width: 50 },
];
for (const a of missingSerial) {
    wsReport.addRow({
        issue: 'Thiếu serial',
        machineCode: a.machineCode,
        name: a.name,
        plant: plantName.get(String(a.plantId)) || '',
        detail: 'Nhập serial khi có dịp đến máy (thay tem/kiểm kê/sửa chữa)',
    });
}
for (const a of missingImage) {
    wsReport.addRow({
        issue: 'Thiếu ảnh',
        machineCode: a.machineCode,
        name: a.name,
        plant: plantName.get(String(a.plantId)) || '',
        detail: '',
    });
}
for (const g of dupCandidates) {
    for (const a of g) {
        wsReport.addRow({
            issue: 'Nghi trùng hồ sơ',
            machineCode: a.machineCode,
            name: a.name,
            plant: plantName.get(String(a.plantId)) || '',
            detail: `Nhóm ${g.length} máy cùng tên/model/cơ sở, đều không serial — kiểm tra có phải 1 máy tạo ${g.length} hồ sơ`,
        });
    }
}
headerStyle(wsReport);

const outDir = path.join(BE_ROOT, 'tmp');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `data-cleanup-${new Date().toISOString().slice(0, 10)}.xlsx`);
await wb.xlsx.writeFile(outFile);

console.log(`\n[cleanup] ✅ Xuất file đề xuất: ${outFile}`);
console.log('[cleanup] Mở file, rà cột "Duyệt", rồi chạy:');
console.log(`[cleanup]   node scripts/data-cleanup-apply.mjs --file "${outFile}"`);

await mongoose.disconnect();
