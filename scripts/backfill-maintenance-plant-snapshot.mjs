/**
 * Backfill maintenance plant snapshot
 *
 * Mục tiêu: Điền plantId / plantName / areaAtCreation vào các Maintenance record
 * đang thiếu snapshot cơ sở (tạo trước khi áp dụng fix bug).
 *
 * Cách chạy:
 *   # dry-run (chỉ xem kết quả, không ghi DB):
 *   node scripts/backfill-maintenance-plant-snapshot.mjs --dry-run
 *
 *   # chạy thật:
 *   node scripts/backfill-maintenance-plant-snapshot.mjs
 *
 * ⚠️  PRODUCTION: backup DB trước khi chạy thật trên môi trường production.
 *
 * Env vars cần có trong .env:
 *   MONGODB_URL_DEV=mongodb://...
 *   MONGODB_DB_NAME=device-management   (optional, default là 'device-management')
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const isDryRun = process.argv.includes('--dry-run');
const mongoUrl = process.env.MONGODB_URL_DEV;
const dbName = process.env.MONGODB_DB_NAME || 'device-management';

if (!mongoUrl) {
    console.error('[backfill] Missing MONGODB_URL_DEV');
    process.exit(1);
}

console.log(`[backfill] Connecting to "${dbName}" (dry-run=${isDryRun}) ...`);
await mongoose.connect(mongoUrl, { dbName });
console.log('[backfill] Connected.');

const maintenances = mongoose.connection.collection('maintenances');
const assets = mongoose.connection.collection('assets');
const plants = mongoose.connection.collection('plants');
const transferHistories = mongoose.connection.collection('transferhistories');

// ──────────────────────────────────────────────────────────────────────────
// 1. Nạp tất cả plant names vào Map để tra cứu nhanh
// ──────────────────────────────────────────────────────────────────────────
const plantDocs = await plants.find({ isDeleted: { $ne: true } }).toArray();
const plantNameMap = new Map(plantDocs.map((p) => [String(p._id), p.name]));

// ──────────────────────────────────────────────────────────────────────────
// 2. Tìm tất cả Maintenance chưa có plantId
// ──────────────────────────────────────────────────────────────────────────
// $or kép để bắt cả field không tồn tại lẫn field null — an toàn hơn chỉ dùng { plantId: null }
const missingCursor = maintenances.find({
    isDeleted: { $ne: true },
    $or: [{ plantId: { $exists: false } }, { plantId: null }],
});
const missingList = await missingCursor.toArray();

console.log(`[backfill] Found ${missingList.length} maintenance records missing plantId.`);

if (!missingList.length) {
    console.log('[backfill] Nothing to do. Exiting.');
    await mongoose.disconnect();
    process.exit(0);
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Xác định plant tại thời điểm bảo trì cho từng record
// ──────────────────────────────────────────────────────────────────────────
let updatedFromHistory = 0;
let updatedFromCurrentAsset = 0;
let unknownCount = 0;
let skippedCount = 0;

for (const maintenance of missingList) {
    // Mốc thời gian của bảo trì — ưu tiên endDate > startDate > createdAt
    const referenceDate = maintenance.endDate ?? maintenance.startDate ?? maintenance.createdAt;
    const assetId = maintenance.assetId;

    if (!assetId) {
        unknownCount++;
        if (!isDryRun) {
            await maintenances.updateOne(
                { _id: maintenance._id },
                { $set: { plantSnapshotSource: 'unknown', plantIdBackfilled: true } }
            );
        }
        continue;
    }

    // Tìm tất cả TransferHistory của máy này, sắp xếp theo createdAt tăng dần
    const historyList = await transferHistories
        .find({ machineId: assetId, isDeleted: { $ne: true } })
        .sort({ createdAt: 1 })
        .toArray();

    let resolvedPlantId = null;
    let resolvedPlantName = null;
    let source = 'unknown';

    if (historyList.length) {
        // Tìm bản ghi TransferHistory gần nhất có createdAt <= referenceDate
        const historiesBefore = historyList.filter(
            (h) => referenceDate && new Date(h.createdAt) <= new Date(referenceDate)
        );

        if (historiesBefore.length) {
            // Bản ghi gần nhất trước mốc → máy đã ở toPlantId của bản ghi đó
            const latest = historiesBefore[historiesBefore.length - 1];
            resolvedPlantId = latest.toPlantId;
            resolvedPlantName = latest.toPlant || plantNameMap.get(String(latest.toPlantId));
            source = 'backfilled_from_transfer_history';
        } else {
            // Tất cả transfer đều SAU mốc → máy chưa bị chuyển tại thời điểm đó
            // → cơ sở ban đầu = fromPlantId của transfer đầu tiên (sớm nhất)
            const earliest = historyList[0];
            resolvedPlantId = earliest.fromPlantId;
            resolvedPlantName = earliest.fromPlant || plantNameMap.get(String(earliest.fromPlantId));
            source = 'backfilled_from_transfer_history';
        }
    }

    // Nếu không giải được từ history, fallback sang asset.plantId hiện tại
    if (!resolvedPlantId) {
        const asset = await assets.findOne({ _id: assetId, isDeleted: { $ne: true } });
        if (asset?.plantId) {
            resolvedPlantId = asset.plantId;
            resolvedPlantName = plantNameMap.get(String(asset.plantId));
            source = 'backfilled_from_current_asset';
        }
    }

    if (!resolvedPlantId) {
        unknownCount++;
        if (!isDryRun) {
            await maintenances.updateOne(
                { _id: maintenance._id },
                { $set: { plantSnapshotSource: 'unknown', plantIdBackfilled: true } }
            );
        }
        console.warn(`[backfill] WARNING: Cannot resolve plantId for maintenance ${maintenance._id}`);
        continue;
    }

    const update = {
        plantId: resolvedPlantId,
        plantName: resolvedPlantName ?? null,
        plantSnapshotSource: source,
        plantIdBackfilled: true,
    };

    if (isDryRun) {
        console.log(
            `[dry-run] maintenance=${maintenance._id}  asset=${assetId}  plant=${resolvedPlantId} (${resolvedPlantName})  source=${source}`
        );
    } else {
        await maintenances.updateOne({ _id: maintenance._id }, { $set: update });
    }

    if (source === 'backfilled_from_transfer_history') updatedFromHistory++;
    else updatedFromCurrentAsset++;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Summary
// ──────────────────────────────────────────────────────────────────────────
const total = missingList.length;
const resolved = updatedFromHistory + updatedFromCurrentAsset;
const fallbackPct = resolved > 0 ? ((updatedFromCurrentAsset / resolved) * 100).toFixed(1) : '0.0';

console.log('\n[backfill] ─── Summary ───────────────────────────────');
console.log(`  Total scanned             : ${total}`);
console.log(`  From TransferHistory      : ${updatedFromHistory}`);
console.log(`  From current asset (est.) : ${updatedFromCurrentAsset}  (${fallbackPct}% of resolved — approximate)`);
console.log(`  Unknown / no asset        : ${unknownCount}`);
console.log(`  Skipped (already set)     : ${skippedCount}`);
console.log(`  Dry-run mode              : ${isDryRun}`);
if (updatedFromCurrentAsset > 0) {
    console.log(
        `\n  ⚠️  ${updatedFromCurrentAsset} record(s) backfilled from current asset — may be inaccurate if machine was transferred.`
    );
    console.log(`     These records have plantSnapshotSource='backfilled_from_current_asset' and plantIdBackfilled=true.`);
}
if (isDryRun) {
    console.log('\n  Run WITHOUT --dry-run to apply the changes.');
}
console.log('──────────────────────────────────────────────────────\n');

await mongoose.disconnect();
