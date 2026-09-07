import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Material from '@/models/Material';
import Assignment from '@/models/MaterialCustodyAssignment';
import Campaign from '@/models/MaterialUsageCampaign';
import Pool from '@/models/ReusableMaterialStock';
import PoolMovement from '@/models/ReusableMaterialMovement';
import Distribution from '@/models/DistributionRecord';
import Inventory from '@/models/InventoryStock';
import StockTransaction from '@/models/StockTransaction';
import Recipient from '@/models/MaterialRecipient';
import User from '@/models/User';
import Notification from '@/models/Notification';
import { evaluateMaterialCustodyReminders } from '../material-custody-reminder.service';
import * as custody from '../material-custody.service';
import { appendInternalItems, finalizeInternalDraft } from '../distribution.service';
import { USER_ROLE } from '@/constant/allowedRoles';

let db: MongoMemoryReplSet;
const plant = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();
let material: any;
let campaign: any;
let assignment: any;
const call = async (handler: any, body = {}, id?: any, query = {}, ownPlant = plant) => {
    let result: any;
    const res = {
        status: () => res,
        json: (payload: any) => {
            result = payload;
            return res;
        },
    };
    await handler(
        {
            body,
            params: { id: id ? String(id) : undefined },
            query,
            role: USER_ROLE.MANAGER,
            userId: String(user),
            user: { plantId: ownPlant },
        },
        res,
        () => {}
    );
    return result;
};
before(async () => {
    // Always use a fresh ephemeral replica set; never read application database credentials.
    db = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(db.getUri('custody_regression'));
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});
after(async () => {
    await mongoose.disconnect();
    if (db) await db.stop();
});
beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
    material = await Material.create({
        name: 'Test scissors',
        code: 'TEST-01',
        unit: 'cai',
        reuseTrackingMode: 'serialized',
    });
    campaign = await Campaign.create({ plantId: plant, campaignCode: 'TEST-CAMPAIGN', itemCode: 'MH01' });
    assignment = await Assignment.create({
        plantId: plant,
        materialId: material._id,
        materialName: material.name,
        unit: 'cai',
        trackingMode: 'serialized',
        holderType: 'team',
        holderName: 'CM1',
        campaignId: campaign._id,
        itemCode: 'MH01',
        sourceType: 'opening_balance',
        quantityIssued: 10,
        unitPrice: 25000,
        issuedAt: new Date(Date.now() - 86400000),
    });
});
test('return -> repair -> reissue conserves reference value without a new expense', async () => {
    await call(custody.resolveAssignment, { quantity: 4, resolution: 'repair' }, assignment._id);
    let pool: any = await Pool.findOne({ materialId: material._id });
    assert.equal(pool.repairQuantity, 4);
    assert.equal(pool.repairReferenceValue, 100000);
    await call(
        custody.processReusableStock,
        { action: 'repair_complete', fromBucket: 'repair', quantity: 3, note: 'Repaired' },
        pool._id
    );
    const issued = await call(custody.reissueReusable, {
        materialId: String(material._id),
        campaignId: String(campaign._id),
        holderType: 'team',
        holderName: 'CM2',
        quantity: 2,
    });
    assert.equal(issued.unitPrice, 25000);
    assert.equal(issued.outstandingValue, 50000);
    pool = await Pool.findById(pool._id);
    assert.equal(pool.availableQuantity, 1);
    assert.equal(pool.availableReferenceValue, 25000);
    assert.equal(pool.repairQuantity, 1);
    assert.equal(pool.repairReferenceValue, 25000);
    assert.equal(await PoolMovement.countDocuments(), 3);
    assert.equal(await StockTransaction.countDocuments(), 0);
});
test('failed reissue rolls back stock and does not create movement', async () => {
    const pool = await Pool.create({
        plantId: plant,
        materialId: material._id,
        availableQuantity: 5,
        availableReferenceValue: 125000,
    });
    await assert.rejects(
        call(custody.reissueReusable, {
            materialId: String(material._id),
            campaignId: String(new mongoose.Types.ObjectId()),
            holderType: 'team',
            holderName: 'CM2',
            quantity: 2,
        })
    );
    assert.equal((await Pool.findById(pool._id))?.availableQuantity, 5);
    assert.equal(await PoolMovement.countDocuments(), 0);
});
test('two concurrent returns cannot resolve more than the outstanding amount', async () => {
    const results = await Promise.allSettled([
        call(custody.resolveAssignment, { quantity: 7, resolution: 'usable' }, assignment._id),
        call(custody.resolveAssignment, { quantity: 7, resolution: 'usable' }, assignment._id),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await Assignment.findById(assignment._id))?.quantityReturnedUsable, 7);
    assert.equal((await Pool.findOne())?.availableQuantity, 7);
});
test('fractional return and transfer are rejected without writes', async () => {
    await assert.rejects(call(custody.resolveAssignment, { quantity: 0.5, resolution: 'usable' }, assignment._id));
    await assert.rejects(
        call(
            custody.transferAssignment,
            { quantity: 0.5, campaignId: String(campaign._id), holderType: 'team', holderName: 'CM2' },
            assignment._id
        )
    );
    assert.equal(await Pool.countDocuments(), 0);
    assert.equal(await Assignment.countDocuments(), 1);
});
test('transferring a holder does not inflate campaign issued quantity', async () => {
    await call(
        custody.transferAssignment,
        { quantity: 3, campaignId: String(campaign._id), holderType: 'team', holderName: 'CM2' },
        assignment._id
    );
    const result = await call(custody.listCampaigns);
    assert.equal(result.data[0].issuedQuantity, 10);
    assert.equal(result.data[0].transferredInQuantity, 3);
    assert.equal(result.data[0].outstandingQuantity, 10);
});
test('legacy pool value requires confirmation; disposal is auditable', async () => {
    const pool = await Pool.create({ plantId: plant, materialId: material._id, damagedQuantity: 2 });
    const body = { action: 'dispose', fromBucket: 'damaged', quantity: 1, note: 'Broken beyond repair' };
    await assert.rejects(call(custody.processReusableStock, body, pool._id));
    await call(custody.processReusableStock, { ...body, referenceUnitPrice: 10000 }, pool._id);
    assert.equal((await Pool.findById(pool._id))?.damagedReferenceValue, 10000);
    assert.equal((await PoolMovement.findOne())?.referenceValue, 10000);
    assert.equal(await StockTransaction.countDocuments(), 0);
});
test('other-plant manager cannot append, finalize or process stock', async () => {
    const other = new mongoose.Types.ObjectId();
    const draft = await Distribution.create({
        fromPlantId: plant,
        distributionType: 'internal_issue',
        status: 'draft',
    });
    await assert.rejects(call(appendInternalItems, { items: [] }, draft._id, {}, other));
    await assert.rejects(call(finalizeInternalDraft, {}, draft._id, {}, other));
    assert.equal((await Distribution.findById(draft._id))?.status, 'draft');
    const pool = await Pool.create({
        plantId: plant,
        materialId: material._id,
        repairQuantity: 1,
        repairReferenceValue: 100,
    });
    await assert.rejects(
        call(
            custody.processReusableStock,
            { action: 'repair_complete', fromBucket: 'repair', quantity: 1, note: 'Test' },
            pool._id,
            {},
            other
        )
    );
    assert.equal((await Pool.findById(pool._id))?.repairQuantity, 1);
});
test('finalize persists edited holder/campaign/date and creates matching assignment', async () => {
    const draft = await Distribution.create({
        fromPlantId: plant,
        toPlantId: plant,
        distributionType: 'internal_issue',
        status: 'draft',
        requesterName: 'Old',
        holderType: 'team',
        holderName: 'Old',
        items: [
            {
                materialId: material._id,
                materialName: material.name,
                unit: 'cai',
                quantity: 2,
                unitPrice: 25000,
                reuseTrackingMode: 'serialized',
            },
        ],
    });
    await new Inventory({ plantId: plant, materialId: material._id, currentStock: 10 }).save();
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    await call(
        finalizeInternalDraft,
        {
            holderType: 'team',
            holderName: 'New',
            requesterName: 'New',
            usageCampaignId: String(campaign._id),
            expectedReturnAt: dueAt,
        },
        draft._id
    );
    const finalized = await Distribution.findById(draft._id);
    assert.equal(finalized?.holderName, 'New');
    assert.equal(finalized?.status, 'confirmed');
    const child = await Assignment.findOne({ sourceDistributionId: draft._id });
    assert.equal(child?.holderName, 'New');
    assert.equal(child?.dueAt?.toISOString(), dueAt);
    assert.equal((await Inventory.findOne())?.currentStock, 8);
    await assert.rejects(
        call(appendInternalItems, { items: [{ materialId: String(material._id), quantity: 1 }] }, draft._id)
    );
});

test('concurrent append/finalize never leaves unexported items on confirmed draft', async () => {
    const draft = await Distribution.create({
        fromPlantId: plant,
        toPlantId: plant,
        distributionType: 'internal_issue',
        status: 'draft',
        holderType: 'team',
        holderName: 'CM1',
        usageCampaignId: campaign._id,
        items: [
            {
                materialId: material._id,
                materialName: material.name,
                unit: 'cai',
                quantity: 2,
                unitPrice: 25000,
                reuseTrackingMode: 'serialized',
            },
        ],
    });
    await new Inventory({ plantId: plant, materialId: material._id, currentStock: 10 }).save();
    await Promise.allSettled([
        call(finalizeInternalDraft, {}, draft._id),
        call(
            appendInternalItems,
            { items: [{ materialId: String(material._id), quantity: 1, unitPrice: 25000 }] },
            draft._id
        ),
    ]);
    let record = await Distribution.findById(draft._id);
    if (record?.status === 'draft') await call(finalizeInternalDraft, {}, draft._id);
    record = await Distribution.findById(draft._id);
    assert.equal(record?.status, 'confirmed');
    const total = record!.items.reduce((sum, item) => sum + item.quantity, 0);
    assert.equal((await Inventory.findOne())?.currentStock, 10 - total);
    assert.equal(await Assignment.countDocuments({ sourceDistributionId: draft._id }), record!.items.length);
});

test('active campaign individual due dates notify only scoped managers and global roles once daily', async () => {
    const now = new Date();
    await Assignment.updateOne({ _id: assignment._id }, { $set: { dueAt: new Date(now.getTime() - 60000) } });
    const foreignUser = new mongoose.Types.ObjectId();
    const adminUser = new mongoose.Types.ObjectId();
    await User.collection.insertMany([
        {
            _id: user,
            username: 'manager-test',
            email: 'manager@example.invalid',
            role: USER_ROLE.MANAGER,
            plantId: plant,
            isActive: true,
        },
        {
            _id: foreignUser,
            username: 'foreign-test',
            email: 'foreign@example.invalid',
            role: USER_ROLE.MANAGER,
            plantId: new mongoose.Types.ObjectId(),
            isActive: true,
        },
        {
            _id: adminUser,
            username: 'admin-test',
            email: 'admin@example.invalid',
            role: USER_ROLE.ADMIN,
            isActive: true,
        },
    ]);
    await evaluateMaterialCustodyReminders('internal', now);
    await evaluateMaterialCustodyReminders('internal', now);
    const notices = await Notification.find().lean();
    assert.equal(notices.length, 2);
    assert.ok(notices.every((n) => String(n.userId) !== String(foreignUser)));
    assert.ok(notices.every((n) => n.actionData?.campaignId === String(campaign._id)));
});

test('recipient search and capped pagination reach records beyond first 200', async () => {
    await Recipient.insertMany(
        Array.from({ length: 205 }, (_, index) => ({
            plantId: plant,
            employeeCode: `CN${index}`,
            fullName: `Worker ${String(index).padStart(3, '0')}`,
            isActive: true,
        }))
    );
    const result = await call(custody.listRecipients, {}, undefined, { page: '2', limit: '500' });
    assert.equal(result.limit, 200);
    assert.equal(result.data.length, 5);
    const found = await call(custody.listRecipients, {}, undefined, { search: 'CN204' });
    assert.equal(found.total, 1);
    assert.equal(found.data[0].employeeCode, 'CN204');
});

test('invalid return chronology and closed campaign reissue leave stock unchanged', async () => {
    await assert.rejects(
        call(custody.resolveAssignment, { quantity: 1, resolution: 'usable', occurredAt: '2000-01-01' }, assignment._id)
    );
    await Pool.create({
        plantId: plant,
        materialId: material._id,
        availableQuantity: 2,
        availableReferenceValue: 50000,
    });
    await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'closed' } });
    await assert.rejects(
        call(custody.reissueReusable, {
            materialId: String(material._id),
            campaignId: String(campaign._id),
            quantity: 1,
            holderType: 'team',
            holderName: 'CM2',
        })
    );
    assert.equal((await Pool.findOne())?.availableQuantity, 2);
    assert.equal(await PoolMovement.countDocuments(), 0);
});
