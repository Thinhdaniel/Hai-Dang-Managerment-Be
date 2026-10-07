import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let db: MongoMemoryServer;
let server: Server;
let baseUrl: string;
let User: typeof import('@/models/User').default;
let UserSession: typeof import('@/models/UserSession').default;
let generateAuthTokens: typeof import('@/services/token.service').generateAuthTokens;
let sequence = 0;
const oldPassword = 'original-password';
const newPassword = 'private-password-2026';
const payload = (currentPassword = oldPassword, nextPassword = newPassword) => ({
    currentPassword,
    newPassword: nextPassword,
    confirmPassword: nextPassword,
});

const request = async (
    path: string,
    options: { token?: string; body?: unknown; method?: string; prefix?: string; cookie?: string } = {}
) => {
    const response = await fetch(`${baseUrl}${options.prefix || '/api'}${path}`, {
        method: options.method || (options.body ? 'POST' : 'GET'),
        headers: {
            'Content-Type': 'application/json',
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
};

const account = async (role = 'worker', password = oldPassword) => {
    const user = await User.create({
        fullname: 'Test worker',
        username: `password-test-${++sequence}`,
        password,
        role,
    });
    return { user, ...(await generateAuthTokens({ _id: user._id, role: user.role })) };
};

before(async () => {
    db = await MongoMemoryServer.create();
    Object.assign(process.env, {
        MONGODB_URL_DEV: db.getUri('worker_password_test'),
        JWT_ACCESS_TOKEN_KEY: 'password-test-access-key',
        JWT_REFRESH_TOKEN_KEY: 'password-test-refresh-key',
        JWT_VERIFY_TOKEN_KEY: 'password-test-verify-key',
        CLOUDINARY_API_KEY: 'test',
        CLOUDINARY_CLOUD_NAME: 'test',
        CLOUDINARY_API_SECRET: 'test',
        EMAIL_USER: 'test@example.com',
        EMAIL_PASSWORD: 'test-password',
        AUTH_BYPASS: 'false',
        AI_ENABLED: 'false',
    });
    await mongoose.connect(db.getUri('worker_password_test'));
    const [{ default: app }, userModule, sessionModule, tokens] = await Promise.all([
        import('@/app'),
        import('@/models/User'),
        import('@/models/UserSession'),
        import('@/services/token.service'),
    ]);
    User = userModule.default;
    UserSession = sessionModule.default;
    generateAuthTokens = tokens.generateAuthTokens;
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
    if (db) await db.stop();
});

test('worker changes password, keeps notebook data, revokes old sessions and receives a usable new session', async () => {
    const { user, accessToken, refreshToken } = await account();
    const otherSession = await generateAuthTokens({ _id: user._id, role: user.role });
    const { default: WorkerNotebook } = await import('@/models/WorkerNotebook');
    await WorkerNotebook.create({
        userId: user._id,
        date: '2026-10-01',
        entries: [{ itemCode: 'TEST', operation: 'Test operation', quantity: 7, unit: 'SP' }],
    });
    await User.updateOne(
        { _id: user._id },
        { passwordResetToken: 'old-reset-token', passwordResetExpiresAt: new Date() }
    );
    const changed = await request('/auth/change-password', { token: accessToken, body: payload() });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.id, String(user._id));
    assert.ok(changed.body.access_token);
    assert.ok(changed.headers.get('set-cookie')?.includes('HttpOnly'));
    const stored = await User.findById(user._id).select('+passwordResetToken +passwordResetExpiresAt');
    assert.ok(stored);
    assert.notEqual(stored.password, newPassword);
    assert.equal(await bcrypt.compare(newPassword, stored.password), true);
    assert.equal(await bcrypt.compare(oldPassword, stored.password), false);
    assert.equal(stored.passwordResetToken, undefined);
    assert.equal(stored.passwordResetExpiresAt, undefined);
    assert.ok(stored.passwordChangedAt);
    for (const token of [accessToken, otherSession.accessToken]) {
        assert.equal((await request('/users/me', { token })).status, 401);
    }
    assert.equal((await request('/auth/refresh-token', { body: { refreshToken } })).status, 401);
    const me = await request('/users/me', { token: changed.body.access_token });
    assert.equal(me.status, 200);
    for (const value of [changed.body.user, me.body, stored.toJSON()]) {
        assert.equal('password' in value, false);
        assert.equal('passwordResetToken' in value, false);
    }
    const newCookie = changed.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/auth/refresh-token', { method: 'POST', cookie: newCookie })).status, 200);
    const notebook = await request('/worker-notebook/day/2026-10-01', { token: changed.body.access_token });
    assert.equal(notebook.status, 200);
    assert.equal(notebook.body.entries[0].quantity, 7);
    assert.equal((await request('/auth/login', { body: { email: user.username, password: oldPassword } })).status, 400);
    assert.equal((await request('/auth/login', { body: { email: user.username, password: newPassword } })).status, 200);
    assert.equal(await UserSession.countDocuments({ userId: user._id, revoked: false }), 2);
});

test('incorrect current password cannot change credentials or revoke sessions', async () => {
    const { user, accessToken } = await account();
    const changed = await request('/auth/change-password', { token: accessToken, body: payload('wrong-password') });
    assert.equal(changed.status, 400);
    assert.equal(changed.body.message, 'Mật khẩu hiện tại không chính xác');
    assert.equal(await bcrypt.compare(oldPassword, (await User.findById(user._id))!.password), true);
    assert.equal((await request('/users/me', { token: accessToken })).status, 200);
});

test('validation rejects weak, unchanged, mismatched, oversized and unconfirmed passwords', async () => {
    const { accessToken } = await account();
    // Separate users keep input validation tests independent from the brute-force limiter.
    for (const body of [
        payload(oldPassword, '1234567'),
        payload(oldPassword, oldPassword),
        { ...payload(), confirmPassword: 'not-matching' },
        { currentPassword: oldPassword, newPassword },
        payload(oldPassword, 'a'.repeat(73)),
        payload(oldPassword, 'ễ'.repeat(25)),
        { ...payload(), currentPassword: '' },
    ]) {
        const current = await account();
        const changed = await request('/auth/change-password', { token: current.accessToken, body });
        assert.equal(changed.status, 400);
        assert.ok(Array.isArray(changed.body.errors));
    }
    assert.equal((await request('/users/me', { token: accessToken })).status, 200);
});

test('legacy six-character current password and UTF-8 password at the bcrypt byte boundary are supported', async () => {
    const { user, accessToken } = await account('worker', '123456');
    const boundaryPassword = 'ễ'.repeat(24);
    assert.equal(Buffer.byteLength(boundaryPassword), 72);
    const changed = await request('/auth/change-password', {
        token: accessToken,
        body: payload('123456', boundaryPassword),
    });
    assert.equal(changed.status, 200);
    assert.equal(await bcrypt.compare(boundaryPassword, (await User.findById(user._id))!.password), true);
});

test('password whitespace is preserved exactly, not trimmed', async () => {
    const { user, accessToken } = await account();
    const password = '  private password  ';
    const changed = await request('/auth/change-password', {
        token: accessToken,
        body: payload(oldPassword, password),
    });
    assert.equal(changed.status, 200);
    const stored = (await User.findById(user._id))!;
    assert.equal(await bcrypt.compare(password, stored.password), true);
    assert.equal(await bcrypt.compare(password.trim(), stored.password), false);
});

test('only authenticated active workers can use change-password; other roles are denied', async () => {
    assert.equal((await request('/auth/change-password', { body: payload() })).status, 401);
    for (const role of ['admin', 'director', 'manager', 'staff', 'line_leader', 'qc']) {
        const { user, accessToken } = await account(role);
        assert.equal((await request('/auth/change-password', { token: accessToken, body: payload() })).status, 403);
        assert.equal(await bcrypt.compare(oldPassword, (await User.findById(user._id))!.password), true);
    }
    for (const update of [{ isActive: false }, { isDeleted: true }]) {
        const { user, accessToken } = await account();
        await User.updateOne({ _id: user._id }, update);
        assert.equal((await request('/auth/change-password', { token: accessToken, body: payload() })).status, 401);
    }
});

test('worker cannot choose another account or inject a role into the password request', async () => {
    const first = await account();
    const second = await account();
    const changed = await request('/auth/change-password', {
        token: first.accessToken,
        body: { ...payload(), userId: String(second.user._id), role: 'admin' },
    });
    assert.equal(changed.status, 400);
    assert.equal(await bcrypt.compare(oldPassword, (await User.findById(second.user._id))!.password), true);
    assert.equal((await request('/users', { token: first.accessToken })).status, 403);
});

test('versioned API prefix also supports worker password changes', async () => {
    const { accessToken } = await account();
    const changed = await request('/auth/change-password', { prefix: '/api/v1', token: accessToken, body: payload() });
    assert.equal(changed.status, 200);
    assert.equal((await request('/users/me', { prefix: '/api/v1', token: changed.body.access_token })).status, 200);
});

test('two concurrent changes using the same password cannot both succeed', async () => {
    const { user, accessToken } = await account();
    const responses = await Promise.all(
        ['concurrent-password-one', 'concurrent-password-two'].map((password) =>
            request('/auth/change-password', { token: accessToken, body: payload(oldPassword, password) })
        )
    );
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.ok(responses.some((response) => [400, 401].includes(response.status)));
    const winner = responses.findIndex((response) => response.status === 200);
    assert.equal((await request('/users/me', { token: responses[winner].body.access_token })).status, 200);
    assert.equal(await bcrypt.compare(oldPassword, (await User.findById(user._id))!.password), false);
});

test('failed attempts are limited per account, across sessions but not across workers sharing an IP', async () => {
    const { user, accessToken } = await account();
    const otherSession = await generateAuthTokens({ _id: user._id, role: user.role });
    for (let i = 0; i < 5; i++) {
        assert.equal(
            (await request('/auth/change-password', { token: accessToken, body: payload('wrong-password') })).status,
            400
        );
    }
    const limited = await request('/auth/change-password', { token: otherSession.accessToken, body: payload() });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const independent = await account();
    assert.equal(
        (await request('/auth/change-password', { token: independent.accessToken, body: payload() })).status,
        200
    );
    assert.equal((await request('/users/me', { token: accessToken })).status, 200);
});
