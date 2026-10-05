import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { USER_ROLE } from '@/constant/allowedRoles';
import User from '@/models/User';
import WorkerNotebook from '@/models/WorkerNotebook';
import { loginSchema } from '@/validations/auth.validation';
import { createUserSchema } from '@/validations/user.validation';

let db: MongoMemoryServer;
const plantId = new mongoose.Types.ObjectId();

before(async () => {
    db = await MongoMemoryServer.create();
    await mongoose.connect(db.getUri('worker_notebook_test'));
    await User.createIndexes();
    await WorkerNotebook.createIndexes();
});

after(async () => {
    await mongoose.disconnect();
    if (db) await db.stop();
});

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), WorkerNotebook.deleteMany({})]);
});

const createWorker = (username: string) =>
    User.create({
        fullname: username,
        username,
        password: 'temporary-password',
        role: USER_ROLE.WORKER,
        plantId,
    });

test('worker accounts can omit email and use distinct usernames', async () => {
    await createWorker('worker001');
    await createWorker('worker002');
    assert.equal(await User.countDocuments({ email: { $exists: false } }), 2);
    await assert.rejects(createWorker('worker001'));
    assert.equal(loginSchema.safeParse({ email: 'worker001', password: 'temporary-password' }).success, true);
    assert.equal(
        createUserSchema.safeParse({
            name: 'Worker',
            username: 'worker003',
            password: '12345678',
            role: USER_ROLE.WORKER,
            plantId: String(plantId),
        }).success,
        true
    );
});

test('a day belongs to one worker and cannot be duplicated', async () => {
    const first = await createWorker('worker001');
    const second = await createWorker('worker002');
    const date = '2026-10-05';
    await WorkerNotebook.create({
        userId: first._id,
        date,
        attended: true,
        entries: [{ itemCode: '416', operation: 'May tui', quantity: 20, unit: 'SP' }],
    });
    await WorkerNotebook.create({
        userId: second._id,
        date,
        attended: false,
        entries: [{ itemCode: '028', operation: 'May suon', quantity: 10, unit: 'SP' }],
    });
    const own = await WorkerNotebook.findOne({ userId: first._id, date });
    assert.equal(own?.entries[0].itemCode, '416');
    assert.equal(own?.attended, true);
    await assert.rejects(WorkerNotebook.create({ userId: first._id, date }));
});
