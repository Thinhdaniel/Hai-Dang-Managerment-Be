import 'dotenv/config';
import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');
const mongoUrl = process.env.MONGODB_URI || process.env.MONGODB_URL_DEV;
const dbName = process.env.MONGODB_DB_NAME || 'device-management';

if (!mongoUrl) {
    console.error('Missing MONGODB_URI or MONGODB_URL_DEV');
    process.exit(1);
}

await mongoose.connect(mongoUrl, { dbName });

const borrowings = mongoose.connection.collection('device_transactions');
const batches = mongoose.connection.collection('borrowingbatches');

const filters = {
    internalItems: { direction: { $exists: false }, type: 'internal' },
    inboundItems: { direction: { $exists: false }, type: { $in: ['external', 'rental'] } },
    inboundBatches: { direction: { $exists: false } },
};

const preview = {
    internalItems: await borrowings.countDocuments(filters.internalItems),
    inboundItems: await borrowings.countDocuments(filters.inboundItems),
    inboundBatches: await batches.countDocuments(filters.inboundBatches),
};

const activeDuplicates = await borrowings
    .aggregate([
        { $match: { isDeleted: { $ne: true }, status: { $in: ['draft', 'active'] } } },
        { $group: { _id: '$assetId', count: { $sum: 1 }, transactionIds: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 50 },
    ])
    .toArray();

console.log(
    JSON.stringify(
        {
            mode: apply ? 'apply' : 'dry-run',
            preview,
            activeDuplicateAssets: activeDuplicates.map((row) => ({
                assetId: String(row._id),
                count: row.count,
                transactionIds: row.transactionIds.map(String),
            })),
        },
        null,
        2
    )
);

if (apply) {
    const [internalResult, inboundResult, batchResult] = await Promise.all([
        borrowings.updateMany(filters.internalItems, { $set: { direction: 'internal' } }),
        borrowings.updateMany(filters.inboundItems, { $set: { direction: 'inbound' } }),
        batches.updateMany(filters.inboundBatches, {
            $set: { direction: 'inbound', labelPolicy: 'temporary', removeQrOnReturn: true },
        }),
    ]);

    console.log(
        JSON.stringify(
            {
                applied: true,
                internalItemsUpdated: internalResult.modifiedCount,
                inboundItemsUpdated: inboundResult.modifiedCount,
                inboundBatchesUpdated: batchResult.modifiedCount,
            },
            null,
            2
        )
    );
}

await mongoose.disconnect();
