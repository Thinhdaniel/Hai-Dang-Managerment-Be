import assert from 'node:assert/strict';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
    v2 as cloudinary,
    type UploadApiOptions,
    type UploadApiResponse,
    type UploadResponseCallback,
} from 'cloudinary';

let db: MongoMemoryServer;
let server: Server;
let url: string;
let token: string;
let secondToken: string;
let userId: string;
let User: (typeof import('@/models/User'))['default'];
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XavkAAAAASUVORK5CYII=',
    'base64'
);
const uploadBody = (bytes = png, mime = 'image/png', name = 'avatar.png') => {
    const form = new FormData();
    form.append('avatar', new Blob([new Uint8Array(bytes)], { type: mime }), name);
    return form;
};
const request = async (method: string, body?: FormData, auth = token, path = '/users/me/avatar') => {
    const response = await fetch(`${url}/api${path}`, {
        method,
        headers: auth ? { Authorization: `Bearer ${auth}` } : {},
        ...(body ? { body } : {}),
    });
    return { status: response.status, body: await response.json() };
};
const mockStorage = (t: TestContext, fail = false) => {
    const uploads: UploadApiOptions[] = [];
    const deleted: string[] = [];
    t.mock.method(
        cloudinary.uploader,
        'upload_stream',
        (options: UploadApiOptions, callback: UploadResponseCallback) => {
            uploads.push(options);
            return new Writable({
                write(_chunk, _encoding, done) {
                    done();
                },
                final(done) {
                    if (fail) callback({ message: 'Provider test failure' } as never, undefined);
                    else
                        callback(undefined, {
                            secure_url: `https://res.cloudinary.com/test/image/upload/${options.public_id}.webp`,
                            public_id: options.public_id,
                        } as UploadApiResponse);
                    done();
                },
            });
        }
    );
    t.mock.method(cloudinary.uploader, 'destroy', async (id: string) => {
        deleted.push(id);
        return { result: 'ok' };
    });
    return { uploads, deleted };
};

before(async () => {
    db = await MongoMemoryServer.create();
    process.env.MONGODB_URL_DEV = db.getUri('avatar_http');
    process.env.JWT_ACCESS_TOKEN_KEY = 'avatar-test-access';
    process.env.JWT_REFRESH_TOKEN_KEY = 'avatar-test-refresh';
    process.env.JWT_VERIFY_TOKEN_KEY = 'avatar-test-verify';
    process.env.CLOUDINARY_API_KEY = 'test';
    process.env.CLOUDINARY_CLOUD_NAME = 'test';
    process.env.CLOUDINARY_API_SECRET = 'test';
    process.env.EMAIL_USER = 'test@example.com';
    process.env.EMAIL_PASSWORD = 'test-password';
    process.env.AUTH_BYPASS = 'false';
    process.env.AI_ENABLED = 'false';
    await mongoose.connect(process.env.MONGODB_URL_DEV);
    const [{ default: app }, userModule] = await Promise.all([import('@/app'), import('@/models/User')]);
    User = userModule.default;
    await User.createIndexes();
    for (const username of ['avatar-one', 'avatar-two'])
        await User.create({
            username,
            fullname: username,
            password: 'password123',
            role: 'worker',
            plantId: new mongoose.Types.ObjectId(),
        });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = async (username: string) => {
        const response = await fetch(`${url}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: username, password: 'password123' }),
        });
        assert.equal(response.status, 200);
        return await response.json();
    };
    const first = await login('avatar-one');
    token = first.access_token;
    userId = first.user.id;
    secondToken = (await login('avatar-two')).access_token;
});
beforeEach(async () => {
    await User.updateMany({}, { $set: { avatarUrl: null, avatarUrlRef: null } });
});
after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
    if (db) await db.stop();
});

test('worker can upload, replace and remove only their own avatar, preserved after reload', async (t) => {
    const storage = mockStorage(t);
    assert.equal((await request('PUT', uploadBody(), '')).status, 401);
    const first = await request('PUT', uploadBody());
    assert.equal(first.status, 200);
    assert.equal(first.body.id, userId);
    assert.equal(first.body.role, 'worker');
    assert.equal(first.body.password, undefined);
    assert.equal(first.body.avatarUrlRef, undefined);
    assert.ok(String(storage.uploads[0].public_id).startsWith(`hai-dang/avatars/${userId}/`));
    assert.equal(storage.uploads[0].format, 'webp');
    assert.equal((await request('GET', undefined, token, '/users/me')).body.avatarUrl, first.body.avatarUrl);
    assert.equal((await request('GET', undefined, secondToken, '/users/me')).body.avatarUrl, null);
    assert.equal((await request('PATCH')).status, 403);
    assert.equal((await request('PUT', uploadBody(), token, `/users/${userId}`)).status, 403);
    const replaced = await request('PUT', uploadBody());
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.body.avatarUrl, first.body.avatarUrl);
    assert.deepEqual(storage.deleted, [storage.uploads[0].public_id]);
    const removed = await request('DELETE');
    assert.equal(removed.status, 200);
    assert.equal(removed.body.avatarUrl, null);
    assert.deepEqual(
        storage.deleted,
        storage.uploads.map((item) => item.public_id)
    );
    assert.equal((await request('DELETE')).status, 200);
    assert.equal(storage.deleted.length, 2);
});

test('invalid files, oversize files and profile-field injection are rejected before storage', async (t) => {
    const storage = mockStorage(t);
    assert.equal((await request('PUT')).status, 400);
    assert.equal((await request('PUT', uploadBody(Buffer.from('<svg/>'), 'image/svg+xml', 'avatar.svg'))).status, 400);
    assert.equal((await request('PUT', uploadBody(Buffer.from('not an image')))).status, 400);
    assert.equal((await request('PUT', uploadBody(Buffer.alloc(5 * 1024 * 1024 + 1)))).status, 400);
    const fields = uploadBody();
    fields.append('role', 'admin');
    fields.append('userId', 'another-user');
    assert.equal((await request('PUT', fields)).status, 400);
    const multiple = uploadBody();
    multiple.append('avatar', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'second.png');
    assert.equal((await request('PUT', multiple)).status, 400);
    assert.equal(storage.uploads.length, 0);
    assert.equal((await User.findById(userId))?.role, 'worker');
});

test('failed upload retains old avatar and cleanup never deletes an unowned storage reference', async (t) => {
    const storage = mockStorage(t, true);
    await User.findByIdAndUpdate(userId, {
        avatarUrl: 'https://example.com/old.jpg',
        avatarUrlRef: 'hai-dang/chat/not-owned',
    });
    assert.equal((await request('PUT', uploadBody())).status, 500);
    assert.equal((await User.findById(userId))?.avatarUrl, 'https://example.com/old.jpg');
    assert.equal(storage.deleted.length, 0);
    assert.equal((await request('DELETE')).status, 200);
    assert.equal(storage.deleted.length, 0);
});

test('concurrent profile change is not overwritten and rejected new upload is cleaned up', async (t) => {
    const storage = mockStorage(t);
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
        ready = resolve;
    });
    let newId: string;
    t.mock.method(
        cloudinary.uploader,
        'upload_stream',
        (options: UploadApiOptions, callback: UploadResponseCallback) => {
            newId = String(options.public_id);
            return new Writable({
                write(_chunk, _encoding, done) {
                    done();
                },
                final(done) {
                    release = () => {
                        callback(undefined, {
                            secure_url: 'https://example.com/new.webp',
                            public_id: newId,
                        } as UploadApiResponse);
                        done();
                    };
                    ready();
                },
            });
        }
    );
    const pending = request('PUT', uploadBody());
    await Promise.race([
        started,
        pending.then((result) => {
            throw new Error(`Upload did not start: ${result.status}`);
        }),
    ]);
    await User.findByIdAndUpdate(userId, { avatarUrl: 'https://example.com/concurrent.jpg' });
    release();
    assert.equal((await pending).status, 409);
    assert.equal((await User.findById(userId))?.avatarUrl, 'https://example.com/concurrent.jpg');
    assert.deepEqual(storage.deleted, [newId!]);
});

test('cleanup failure does not roll back a saved or removed avatar', async (t) => {
    mockStorage(t);
    t.mock.method(cloudinary.uploader, 'destroy', async () => {
        throw new Error('Storage unavailable');
    });
    await User.findByIdAndUpdate(userId, {
        avatarUrl: 'https://example.com/old.webp',
        avatarUrlRef: `hai-dang/avatars/${userId}/old`,
    });
    const uploaded = await request('PUT', uploadBody());
    assert.equal(uploaded.status, 200);
    assert.equal((await User.findById(userId))?.avatarUrl, uploaded.body.avatarUrl);
    assert.equal((await request('DELETE')).status, 200);
    assert.equal((await User.findById(userId))?.avatarUrl, null);
});

test('avatar mutation rate limit is per account', async (t) => {
    mockStorage(t);
    for (let i = 0; i < 20; i++) assert.equal((await request('DELETE', undefined, secondToken)).status, 200);
    assert.equal((await request('DELETE', undefined, secondToken)).status, 429);
    assert.equal((await request('GET', undefined, secondToken, '/users/me')).status, 200);
    assert.equal((await request('DELETE')).status, 200);
});
