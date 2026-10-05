import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let db: MongoMemoryServer;
let server: Server;
let baseUrl: string;
let adminToken: string;
let firstToken: string;
let secondToken: string;

const request = async (path: string, options: { method?: string; token?: string; body?: unknown } = {}) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
        method: options.method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() };
};

before(async () => {
    db = await MongoMemoryServer.create();
    process.env.MONGODB_URL_DEV = db.getUri('worker_notebook_http');
    process.env.JWT_ACCESS_TOKEN_KEY = 'worker-test-access-key';
    process.env.JWT_REFRESH_TOKEN_KEY = 'worker-test-refresh-key';
    process.env.JWT_VERIFY_TOKEN_KEY = 'worker-test-verify-key';
    process.env.CLOUDINARY_API_KEY = 'test';
    process.env.CLOUDINARY_CLOUD_NAME = 'test';
    process.env.CLOUDINARY_API_SECRET = 'test';
    process.env.EMAIL_USER = 'test@example.com';
    process.env.EMAIL_PASSWORD = 'test-password';
    process.env.AUTH_BYPASS = 'false';
    process.env.AI_ENABLED = 'false';
    await mongoose.connect(process.env.MONGODB_URL_DEV);
    const [{ default: app }, { default: User }, { default: WorkerNotebook }, { ensureOptionalUserEmailIndex }] =
        await Promise.all([
            import('@/app'),
            import('@/models/User'),
            import('@/models/WorkerNotebook'),
            import('@/config/database.config'),
        ]);
    await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    await ensureOptionalUserEmailIndex();
    const emailIndex = (await User.collection.indexes()).find((index) => index.key?.email === 1);
    assert.equal(emailIndex?.partialFilterExpression?.email?.$type, 'string');
    await WorkerNotebook.createIndexes();
    const admin = await User.create({
        fullname: 'Admin',
        username: 'admin-test',
        email: 'admin@example.com',
        password: 'password123',
        role: 'admin',
    });
    const plantId = String(new mongoose.Types.ObjectId());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await request('/auth/login', {
        method: 'POST',
        body: { email: admin.email, password: 'password123' },
    });
    assert.equal(login.status, 200);
    adminToken = login.body.access_token;
    for (const username of ['worker-one', 'worker-two']) {
        const created = await request('/users', {
            method: 'POST',
            token: adminToken,
            body: {
                name: username,
                username,
                password: 'password123',
                role: 'worker',
                plantId,
            },
        });
        assert.equal(created.status, 201);
    }
    firstToken = (
        await request('/auth/login', { method: 'POST', body: { email: 'worker-one', password: 'password123' } })
    ).body.access_token;
    secondToken = (
        await request('/auth/login', { method: 'POST', body: { email: 'worker-two', password: 'password123' } })
    ).body.access_token;
});

after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
    if (db) await db.stop();
});

test('worker can mark attendance and write a personal operation entry', async () => {
    const date = '2026-10-05';
    const marked = await request(`/worker-notebook/day/${date}/attendance`, {
        method: 'PUT',
        token: firstToken,
        body: { attended: true },
    });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.attended, true);
    const added = await request(`/worker-notebook/day/${date}/entries`, {
        method: 'POST',
        token: firstToken,
        body: {
            itemCode: '416',
            operation: 'May tui',
            quantity: 20,
            unit: 'SP',
            note: '',
        },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.entries.length, 1);
    const id = added.body.entries[0]._id;
    const edited = await request(`/worker-notebook/day/${date}/entries/${id}`, {
        method: 'PATCH',
        token: firstToken,
        body: {
            itemCode: '416',
            operation: 'May tui',
            quantity: 22,
            unit: 'SP',
            note: 'Bo sung',
        },
    });
    assert.equal(edited.body.entries[0].quantity, 22);
    const month = await request('/worker-notebook/month?month=2026-10', { token: firstToken });
    assert.equal(month.body.attendedDays, 1);
    assert.equal(month.body.breakdown[0].quantity, 22);
    const otherDay = await request(`/worker-notebook/day/${date}`, { token: secondToken });
    assert.equal(otherDay.body.entries.length, 0);
    assert.equal(otherDay.body.attendanceRecorded, false);
    const otherEdit = await request(`/worker-notebook/day/${date}/entries/${id}`, {
        method: 'PATCH',
        token: secondToken,
        body: {
            itemCode: '416',
            operation: 'May tui',
            quantity: 99,
            unit: 'SP',
            note: '',
        },
    });
    assert.equal(otherEdit.status, 404);
    const removed = await request(`/worker-notebook/day/${date}/entries/${id}`, {
        method: 'DELETE',
        token: firstToken,
    });
    assert.equal(removed.body.entries.length, 0);
});

test('worker cannot access management endpoints', async () => {
    assert.equal((await request('/users', { token: firstToken })).status, 403);
    assert.equal((await request('/assets', { token: firstToken })).status, 403);
    assert.equal((await request('/worker-notebook/month', { token: adminToken })).status, 403);
    assert.equal((await request('/users/me', { token: firstToken })).status, 200);
});

test('monthly report includes legacy attendance, half days, overtime and unit-separated production', async () => {
    const { default: WorkerNotebook } = await import('@/models/WorkerNotebook');
    const { default: User } = await import('@/models/User');
    const worker = await User.findOne({ username: 'worker-one' });
    assert.ok(worker);
    await WorkerNotebook.create({ userId: worker._id, date: '2026-10-01', attended: true });
    const legacy = await request('/worker-notebook/day/2026-10-01', { token: firstToken });
    assert.equal(legacy.body.attendanceType, 'full');
    assert.equal(legacy.body.attendanceRecorded, true);
    assert.equal(legacy.body.workDays, 1);
    assert.equal(legacy.body.overtimeHours, 0);
    for (const [date, attendanceType, overtimeHours] of [
        ['2026-10-02', 'half', 2.5],
        ['2026-10-03', 'off', 4],
        ['2026-10-04', 'full', 1.25],
    ] as const) {
        const result = await request(`/worker-notebook/day/${date}/attendance`, {
            method: 'PUT',
            token: firstToken,
            body: { attendanceType, overtimeHours },
        });
        assert.equal(result.status, 200);
        assert.equal(result.body.overtimeHours, overtimeHours);
    }
    for (const [date, unit, quantity] of [
        ['2026-10-02', 'SP', 10],
        ['2026-10-02', 'Bo', 2],
        ['2026-10-03', 'SP', 7],
    ] as const) {
        assert.equal(
            (
                await request(`/worker-notebook/day/${date}/entries`, {
                    method: 'POST',
                    token: firstToken,
                    body: { itemCode: '416', operation: 'May tui', unit, quantity },
                })
            ).status,
            201
        );
    }
    const month = (await request('/worker-notebook/month?month=2026-10', { token: firstToken })).body;
    assert.equal(month.fullDays, 3);
    assert.equal(month.halfDays, 1);
    assert.equal(month.workDays, 3.5);
    assert.equal(month.overtimeHours, 7.75);
    assert.equal(month.productionDays, 2);
    assert.equal(month.entryCount, 3);
    assert.equal(month.breakdown.find((entry: { unit: string }) => entry.unit === 'SP').quantity, 17);
    assert.equal(month.breakdown.find((entry: { unit: string }) => entry.unit === 'SP').recordedDays, 2);
    assert.equal(month.totalsByUnit.find((entry: { unit: string }) => entry.unit === 'Bo').quantity, 2);
    assert.equal(month.days.find((day: { date: string }) => day.date === '2026-10-03').workDays, 0);
    assert.equal(month.days.find((day: { date: string }) => day.date === '2026-10-03').attendanceRecorded, true);
    const isolated = (await request('/worker-notebook/month?month=2026-10', { token: secondToken })).body;
    assert.equal(isolated.workDays, 0);
    assert.equal(isolated.overtimeHours, 0);
    assert.deepEqual(isolated.breakdown, []);
    // Cached clients must not erase the newer half-day or overtime fields.
    await request('/worker-notebook/day/2026-10-02/attendance', {
        method: 'PUT',
        token: firstToken,
        body: { attended: true },
    });
    assert.equal((await request('/worker-notebook/day/2026-10-02', { token: firstToken })).body.attendanceType, 'half');
    await request('/worker-notebook/day/2026-10-02/attendance', {
        method: 'PUT',
        token: firstToken,
        body: { attendanceType: 'full', overtimeHours: 3 },
    });
    const revised = (await request('/worker-notebook/month?month=2026-10', { token: firstToken })).body;
    assert.equal(revised.workDays, 4);
    assert.equal(revised.overtimeHours, 8.25);
    assert.equal(revised.halfDays, 0);
    assert.equal(revised.entryCount, 3);
    for (const body of [
        { attendanceType: 'half', overtimeHours: -1 },
        { attendanceType: 'full', overtimeHours: 25 },
        { attendanceType: 'full', overtimeHours: '2' },
        { attendanceType: 'full', overtimeHours: 0.123 },
        { attendanceType: 'invalid', overtimeHours: 0, attended: true },
    ]) {
        assert.equal(
            (
                await request('/worker-notebook/day/2026-10-02/attendance', {
                    method: 'PUT',
                    token: firstToken,
                    body,
                })
            ).status,
            400
        );
    }
    const empty = (await request('/worker-notebook/month?month=2026-09', { token: firstToken })).body;
    assert.equal(empty.workDays, 0);
    assert.equal(empty.overtimeHours, 0);
    assert.deepEqual(empty.totalsByUnit, []);
});

test('admin can reset a worker password without email', async () => {
    const users = await request('/users', { token: adminToken });
    const worker = users.body.find((item: { username?: string }) => item.username === 'worker-one');
    assert.ok(worker?.id);
    const reset = await request(`/users/${worker.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { password: 'new-password-123' },
    });
    assert.equal(reset.status, 200);
    assert.equal(
        (await request('/auth/login', { method: 'POST', body: { email: 'worker-one', password: 'password123' } }))
            .status,
        400
    );
    assert.equal((await request('/users/me', { token: firstToken })).status, 401);
    const login = await request('/auth/login', {
        method: 'POST',
        body: { email: 'worker-one', password: 'new-password-123' },
    });
    assert.equal(login.status, 200);
    assert.equal((await request('/users/me', { token: login.body.access_token })).status, 200);
});
