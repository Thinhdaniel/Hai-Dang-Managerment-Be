import assert from 'node:assert/strict';
import test from 'node:test';
import { BORROWING_DIRECTION, resolveBorrowingDirection } from '@/constant/borrowing';
import { createBorrowingBatchSchema } from '@/validations/borrowing.validation';

const baseOutboundPayload = {
    type: 'external' as const,
    direction: BORROWING_DIRECTION.OUTBOUND,
    partnerName: 'Công ty đối tác',
    purpose: 'Cho mượn phục vụ đơn hàng ngắn hạn',
    plantId: '507f1f77bcf86cd799439011',
    borrowTime: '2026-08-28T08:00:00.000Z',
    expectedReturnTime: '2026-09-28T08:00:00.000Z',
    plannedQuantity: 3,
    createQrBatch: false,
};

test('suy ra đúng chiều cho dữ liệu cũ và dữ liệu outbound mới', () => {
    assert.equal(resolveBorrowingDirection(undefined, 'internal'), BORROWING_DIRECTION.INTERNAL);
    assert.equal(resolveBorrowingDirection(undefined, 'external'), BORROWING_DIRECTION.INBOUND);
    assert.equal(resolveBorrowingDirection(BORROWING_DIRECTION.OUTBOUND, 'external'), BORROWING_DIRECTION.OUTBOUND);
});

test('chấp nhận lô Hải Đăng cho đối tác mượn có đủ thông tin', () => {
    const result = createBorrowingBatchSchema.safeParse(baseOutboundPayload);
    assert.equal(result.success, true);
});

test('lô outbound bắt buộc đối tác, mục đích và hạn trả', () => {
    const result = createBorrowingBatchSchema.safeParse({
        ...baseOutboundPayload,
        partnerName: '',
        purpose: '',
        expectedReturnTime: '',
    });
    assert.equal(result.success, false);
    if (result.success) return;

    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    assert.ok(paths.includes('partnerName'));
    assert.ok(paths.includes('purpose'));
    assert.ok(paths.includes('expectedReturnTime'));
});

test('không cho dùng loại thuê hoặc tạo QR tạm trong lô outbound', () => {
    const result = createBorrowingBatchSchema.safeParse({
        ...baseOutboundPayload,
        type: 'rental',
        createQrBatch: true,
    });
    assert.equal(result.success, false);
    if (result.success) return;

    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    assert.ok(paths.includes('type'));
    assert.ok(paths.includes('createQrBatch'));
});

test('không chấp nhận hạn trả trước thời gian bàn giao', () => {
    const result = createBorrowingBatchSchema.safeParse({
        ...baseOutboundPayload,
        expectedReturnTime: '2026-08-27T08:00:00.000Z',
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'expectedReturnTime'));
});

test('giữ tương thích luồng inbound hiện có không bắt buộc hạn trả', () => {
    const result = createBorrowingBatchSchema.safeParse({
        type: 'external',
        direction: BORROWING_DIRECTION.INBOUND,
        plantId: '507f1f77bcf86cd799439011',
        borrowTime: '2026-08-28T08:00:00.000Z',
        plannedQuantity: 2,
        createQrBatch: true,
    });
    assert.equal(result.success, true);
});
