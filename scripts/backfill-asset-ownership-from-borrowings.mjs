import 'dotenv/config';
import mongoose from 'mongoose';

const mongoUrl = process.env.MONGODB_URL_DEV;
const dbName = process.env.MONGODB_DB_NAME || 'device-management';

if (!mongoUrl) {
    console.error('Missing MONGODB_URL_DEV');
    process.exit(1);
}

const ownershipByBorrowingType = {
    external: 'partner_borrowed',
    rental: 'rental',
};

await mongoose.connect(mongoUrl, { dbName });

const assets = mongoose.connection.collection('assets');
const borrowings = mongoose.connection.collection('device_transactions');

const baseAssetFilter = { isDeleted: { $ne: true } };
const externalBorrowingFilter = {
    isDeleted: { $ne: true },
    type: { $in: ['external', 'rental'] },
    assetId: { $exists: true, $ne: null },
};

const defaultOwnedResult = await assets.updateMany(
    { ...baseAssetFilter, ownershipType: { $exists: false } },
    { $set: { ownershipType: 'owned' } }
);

const activeBorrowings = await borrowings
    .find({ ...externalBorrowingFilter, status: 'active' })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

const touchedAssetIds = new Set();
let activeUpdated = 0;

for (const borrowing of activeBorrowings) {
    const assetId = String(borrowing.assetId);
    if (touchedAssetIds.has(assetId)) continue;

    const result = await assets.updateOne(
        { _id: borrowing.assetId, ...baseAssetFilter },
        {
            $set: {
                ownershipType: ownershipByBorrowingType[borrowing.type],
                status: 'borrowing',
            },
        }
    );

    if (result.modifiedCount) activeUpdated += 1;
    touchedAssetIds.add(assetId);
}

const returnedBorrowings = await borrowings
    .find({ ...externalBorrowingFilter, status: 'returned' })
    .sort({ returnTime: -1, updatedAt: -1, createdAt: -1 })
    .toArray();

let returnedUpdated = 0;

for (const borrowing of returnedBorrowings) {
    const assetId = String(borrowing.assetId);
    if (touchedAssetIds.has(assetId)) continue;

    const result = await assets.updateOne(
        { _id: borrowing.assetId, ...baseAssetFilter },
        {
            $set: {
                ownershipType: ownershipByBorrowingType[borrowing.type],
                status: 'returned_to_partner',
            },
        }
    );

    if (result.modifiedCount) returnedUpdated += 1;
    touchedAssetIds.add(assetId);
}

console.log(
    JSON.stringify(
        {
            defaultOwnedUpdated: defaultOwnedResult.modifiedCount,
            activeExternalOrRentalUpdated: activeUpdated,
            returnedExternalOrRentalUpdated: returnedUpdated,
        },
        null,
        2
    )
);

await mongoose.disconnect();
