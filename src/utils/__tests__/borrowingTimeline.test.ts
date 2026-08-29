import assert from 'node:assert/strict';
import test from 'node:test';
import { getOutboundHandoverTimelineError } from '@/utils/borrowingTimeline';

test('cho phép ghi nhận bàn giao hồi tố trước ngày phê duyệt trên hệ thống', () => {
    const error = getOutboundHandoverTimelineError({
        handoverTime: new Date('2026-08-28T08:00:00.000Z'),
        expectedReturnTime: new Date('2026-09-28T08:00:00.000Z'),
        now: new Date('2026-08-29T08:00:00.000Z'),
    });

    assert.equal(error, null);
});

test('không cho ghi nhận thời điểm bàn giao trong tương lai', () => {
    const error = getOutboundHandoverTimelineError({
        handoverTime: new Date('2026-08-29T08:06:00.000Z'),
        now: new Date('2026-08-29T08:00:00.000Z'),
    });

    assert.equal(error, 'Thoi gian ban giao khong duoc nam trong tuong lai');
});

test('hạn trả dự kiến phải sau thời điểm bàn giao thực tế', () => {
    const error = getOutboundHandoverTimelineError({
        handoverTime: new Date('2026-08-28T08:00:00.000Z'),
        expectedReturnTime: new Date('2026-08-28T08:00:00.000Z'),
        now: new Date('2026-08-29T08:00:00.000Z'),
    });

    assert.equal(error, 'Han tra du kien phai sau thoi gian ban giao');
});
