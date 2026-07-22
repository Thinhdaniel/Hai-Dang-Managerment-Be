/**
 * Rà (và tuỳ chọn xoá) các bản ghi chuyền bị nhồi ngược vào ngày sản xuất cũ.
 *
 * Nguyên nhân: ensureDayLineRecords cũ chạy ở MỌI lần đọc ngày nháp, nên mỗi lần
 * thêm chuyền mới vào danh mục là nó tạo bản ghi trắng cho tất cả ngày còn nháp.
 *
 * Tiêu chí xoá (phải thoả hết): tạo sau ngày sản xuất >2 phút, không có run,
 * không có entry, workerCount = 0. Tức chắc chắn chưa ai đụng vào.
 *
 * Dùng:  node scripts/production-orphan-line-records.mjs           (chỉ rà)
 *        node scripts/production-orphan-line-records.mjs --apply   (xoá thật)
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const GRACE_MS = 2 * 60 * 1000;

const uri = process.env.MONGODB_URL_DEV || process.env.MONGODB_URL_PROD;
if (!uri) throw new Error('Thiếu MONGODB_URL_DEV/MONGODB_URL_PROD');

await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'device-management' });
const db = mongoose.connection.db;
console.log(`DB: ${db.databaseName} · chế độ: ${APPLY ? 'XOÁ THẬT' : 'chỉ rà'}`);

const days = await db.collection('productiondays').find({}).toArray();
const dayById = new Map(days.map((day) => [String(day._id), day]));

const records = await db.collection('productionlinerecords').find({}).toArray();
const suspects = records.filter((record) => {
    const day = dayById.get(String(record.dayId));
    if (!day) return false;
    if (record.runs?.length || record.entries?.length) return false;
    if (Number(record.workerCount) > 0) return false;
    const createdAt = record.createdAt ? new Date(record.createdAt).getTime() : 0;
    const dayCreatedAt = day.createdAt ? new Date(day.createdAt).getTime() : 0;
    return createdAt && dayCreatedAt && createdAt - dayCreatedAt > GRACE_MS;
});

const byDate = new Map();
suspects.forEach((record) => {
    const key = `${record.productionDate} (${dayById.get(String(record.dayId))?.status})`;
    byDate.set(key, [...(byDate.get(key) || []), record.lineCode]);
});

console.log(`Tổng bản ghi chuyền: ${records.length} · nghi bị nhồi: ${suspects.length}`);
[...byDate.entries()]
    .sort()
    .forEach(([date, codes]) => console.log(`  ${date}: ${codes.sort().join(', ')}`));

if (APPLY && suspects.length) {
    const result = await db
        .collection('productionlinerecords')
        .deleteMany({ _id: { $in: suspects.map((record) => record._id) } });
    console.log(`Đã xoá ${result.deletedCount} bản ghi.`);
} else if (suspects.length) {
    console.log('Chưa xoá gì. Chạy lại với --apply nếu danh sách trên là đúng.');
}

await mongoose.disconnect();
