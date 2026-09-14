import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProductionMasterPlanSchema } from '../../validations/production.validation';
import {
    buildCapacityDates,
    capacityMinutesForAllocation,
    capacityMonday,
    consumeCapacityForQuantity,
    medianCapacityRate,
    reserveRegularCapacityWindow,
} from '../production-capacity.helpers';

test('chuẩn hóa kỳ năng lực về Thứ Hai và sinh đủ ngày', () => {
    assert.equal(capacityMonday('2026-09-12'), '2026-09-07');
    assert.equal(capacityMonday('2026-09-13'), '2026-09-07');
    const dates = buildCapacityDates('2026-09-07', 2);
    assert.equal(dates.length, 14);
    assert.equal(dates.at(-1), '2026-09-20');
});

test('tách đúng phút thường và tăng ca trong khoảng phân bổ', () => {
    const result = capacityMinutesForAllocation(
        [
            { key: 'a', startMinute: 420, endMinute: 480, kind: 'regular', isActive: true },
            { key: 'b', startMinute: 480, endMinute: 540, kind: 'regular', isActive: true },
            { key: 'c', startMinute: 1020, endMinute: 1080, kind: 'overtime', isActive: true },
        ],
        'b',
        'c'
    );
    assert.deepEqual(result, { regularMinutes: 60, overtimeMinutes: 60, valid: true });
});

test('lấy trung vị năng suất để chống một lần nhập bất thường', () => {
    assert.equal(medianCapacityRate([20, 21, 22, 200]), 21.5);
    assert.equal(medianCapacityRate([0, Number.NaN]), 0);
});

test('mô phỏng dùng chung quỹ phút và giữ phần chưa xếp khi hết năng lực', () => {
    const buckets = [
        { date: '2026-09-14', lineId: 'L1', availableMinutes: 60 },
        { date: '2026-09-15', lineId: 'L1', availableMinutes: 30 },
    ];
    const result = consumeCapacityForQuantity({ buckets, quantity: 40, hourlyRate: 20, notBefore: '2026-09-14' });
    assert.equal(result.projectedCompletionDate, '2026-09-15');
    assert.equal(result.unallocatedQuantity, 10);
    assert.equal(buckets[0].availableMinutes, 0);
    assert.equal(buckets[1].availableMinutes, 0);
    assert.deepEqual(result.allocations, [
        { date: '2026-09-14', lineId: 'L1', quantity: 20, minutes: 60 },
        { date: '2026-09-15', lineId: 'L1', quantity: 10, minutes: 30 },
    ]);
});

test('đề xuất phân bổ giữ đúng chuyền, ngày và không vượt quỹ phút', () => {
    const buckets = [
        { date: '2026-09-14', lineId: 'line-1', availableMinutes: 30 },
        { date: '2026-09-14', lineId: 'line-2', availableMinutes: 60 },
        { date: '2026-09-15', lineId: 'line-1', availableMinutes: 60 },
    ];
    const result = consumeCapacityForQuantity({
        buckets,
        quantity: 100,
        hourlyRate: 60,
        notBefore: '2026-09-14',
    });

    assert.equal(result.unallocatedQuantity, 0);
    assert.equal(result.projectedCompletionDate, '2026-09-15');
    assert.deepEqual(result.allocations, [
        { date: '2026-09-14', lineId: 'line-1', quantity: 30, minutes: 30 },
        { date: '2026-09-14', lineId: 'line-2', quantity: 60, minutes: 60 },
        { date: '2026-09-15', lineId: 'line-1', quantity: 10, minutes: 10 },
    ]);
    assert.equal(
        buckets.reduce((sum, bucket) => sum + bucket.availableMinutes, 0),
        50
    );
});

test('reserves a contiguous regular window without overlapping existing allocations', () => {
    const slots = [
        { key: '07-08', startMinute: 420, endMinute: 480, kind: 'regular' as const, isActive: true },
        { key: '08-09', startMinute: 480, endMinute: 540, kind: 'regular' as const, isActive: true },
        { key: '09-10', startMinute: 540, endMinute: 600, kind: 'regular' as const, isActive: true },
        { key: '17-18', startMinute: 1020, endMinute: 1080, kind: 'overtime' as const, isActive: true },
    ];
    const reserved = reserveRegularCapacityWindow({
        slots,
        occupiedWindows: [{ startSlotKey: '07-08', endSlotKey: '07-08' }],
        requiredMinutes: 90,
    });
    assert.deepEqual(reserved, {
        startSlotKey: '08-09',
        endSlotKey: '09-10',
        reservedMinutes: 120,
        slotKeys: ['08-09', '09-10'],
    });
});

test('does not combine overtime or separated regular windows', () => {
    const reserved = reserveRegularCapacityWindow({
        slots: [
            { key: '07-08', startMinute: 420, endMinute: 480, kind: 'regular', isActive: true },
            { key: '08-09', startMinute: 480, endMinute: 540, kind: 'regular', isActive: true },
            { key: '09-10', startMinute: 540, endMinute: 600, kind: 'regular', isActive: true },
            { key: '17-18', startMinute: 1020, endMinute: 1080, kind: 'overtime', isActive: true },
        ],
        occupiedWindows: [{ startSlotKey: '08-09', endSlotKey: '08-09' }],
        requiredMinutes: 90,
    });
    assert.equal(reserved, undefined);
});

test('master-plan apply validation requires a checked fingerprint before confirmation', () => {
    const base = {
        plantId: '64b000000000000000000001',
        suggestions: [
            {
                orderId: '64b000000000000000000002',
                date: '2026-09-14',
                lineId: '64b000000000000000000003',
                quantity: 120,
                hourlyQuota: 60,
            },
        ],
    };
    assert.equal(applyProductionMasterPlanSchema.safeParse({ ...base, confirm: false }).success, true);
    assert.equal(applyProductionMasterPlanSchema.safeParse({ ...base, confirm: true }).success, false);
    assert.equal(
        applyProductionMasterPlanSchema.safeParse({
            ...base,
            confirm: true,
            expectedFingerprint: 'a'.repeat(64),
        }).success,
        true
    );
});

test('master-plan apply validation rejects duplicate proposal rows', () => {
    const suggestion = {
        orderId: '64b000000000000000000002',
        date: '2026-09-14',
        lineId: '64b000000000000000000003',
        quantity: 120,
        hourlyQuota: 60,
    };
    const result = applyProductionMasterPlanSchema.safeParse({
        plantId: '64b000000000000000000001',
        suggestions: [suggestion, suggestion],
        confirm: false,
    });
    assert.equal(result.success, false);
});
