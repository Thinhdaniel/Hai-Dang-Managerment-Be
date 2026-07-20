import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildProductionDayDetail,
    redactProductionFinancials,
    resolveRunForSlot,
    validateProductionDayForSubmission,
} from '@/services/production.helpers';

const slots = [
    { key: '08:00', label: '8h', startMinute: 480, endMinute: 540, kind: 'regular', isActive: true },
    { key: '09:00', label: '9h30', startMinute: 540, endMinute: 570, kind: 'regular', isActive: true },
];

const runs = [
    {
        _id: 'run-a',
        itemId: 'item-a',
        itemCode: 'A-01',
        unit: 'SP',
        unitPriceSnapshot: 1_000,
        hourlyQuota: 100,
        startedSlotKey: '08:00',
        endedSlotKey: '08:00',
        status: 'closed',
        createdAt: new Date('2026-07-18T01:00:00.000Z'),
    },
    {
        _id: 'run-b',
        itemId: 'item-b',
        itemCode: 'B-02',
        unit: 'SP',
        unitPriceSnapshot: 2_000,
        hourlyQuota: 80,
        startedSlotKey: '09:00',
        status: 'active',
        createdAt: new Date('2026-07-18T02:00:00.000Z'),
    },
];

test('tính khoán theo đúng thời lượng từng khung giờ, không mặc định một giờ', () => {
    const detail = buildProductionDayDetail(
        {
            _id: 'day-1',
            plantId: 'plant-1',
            productionDate: '2026-07-18',
            timeSlots: slots,
        },
        [
            {
                _id: 'record-1',
                dayId: 'day-1',
                plantId: 'plant-1',
                productionDate: '2026-07-18',
                lineId: 'line-1',
                lineCode: 'CM1',
                workerCount: 20,
                workerCountConfirmedAt: new Date('2026-07-18T00:30:00.000Z'),
                runs,
                entries: [
                    { _id: 'entry-a', slotKey: '08:00', runId: 'run-a', quantity: 90 },
                    { _id: 'entry-b', slotKey: '09:00', runId: 'run-b', quantity: 0 },
                ],
            },
        ]
    );

    const line = detail.lines[0];
    assert.equal(line.slotValues[0].target, 100);
    assert.equal(line.slotValues[1].target, 40);
    assert.equal(line.totalTarget, 140);
    assert.equal(line.totalActual, 90);
});

test('sản lượng bằng 0 vẫn là đã báo và tiền dùng đúng đơn giá snapshot của từng mã', () => {
    const detail = buildProductionDayDetail(
        {
            _id: 'day-1',
            plantId: 'plant-1',
            productionDate: '2026-07-18',
            timeSlots: slots,
        },
        [
            {
                _id: 'record-1',
                dayId: 'day-1',
                plantId: 'plant-1',
                productionDate: '2026-07-18',
                lineId: 'line-1',
                lineCode: 'CM1',
                workerCount: 20,
                workerCountConfirmedAt: new Date('2026-07-18T00:30:00.000Z'),
                runs,
                entries: [
                    { _id: 'entry-a', slotKey: '08:00', runId: 'run-a', quantity: 90 },
                    { _id: 'entry-b', slotKey: '09:00', runId: 'run-b', quantity: 0 },
                ],
            },
        ]
    );

    const line = detail.lines[0];
    assert.equal(line.slotValues[1].reported, true);
    assert.equal(detail.slotSummaries[1].reportedLines, 1);
    assert.equal(line.totalAmount, 90_000);
    assert.equal(detail.summary.itemCount, 2);
});

test('khi đổi mã đúng đầu khung giờ, ưu tiên lần chạy được tạo sau', () => {
    const sameSlotRuns = [
        { ...runs[0], startedSlotKey: '09:00', endedSlotKey: '09:00', createdAt: new Date('2026-07-18T01:00:00Z') },
        { ...runs[1], startedSlotKey: '09:00', createdAt: new Date('2026-07-18T02:00:00Z') },
    ];

    assert.equal(resolveRunForSlot(sameSlotRuns, '09:00', slots)?._id, 'run-b');
});

test('không cho gửi duyệt khi một khung giờ có mã chạy nhưng chưa báo sản lượng', () => {
    const result = validateProductionDayForSubmission({
        timeSlots: slots,
        lines: [
            {
                lineCode: 'CM1',
                configured: true,
                entries: [{ quantity: 10 }],
                slotValues: [
                    { key: '08:00', runId: 'run-a', reported: true },
                    { key: '09:00', runId: 'run-b', reported: false },
                ],
            },
        ],
    });

    assert.equal(result.valid, false);
    assert.match(result.message || '', /CM1 - 9h30/);
});

test('cho gửi duyệt khi tất cả khung giờ đang chạy đã được báo, kể cả sản lượng bằng 0', () => {
    const result = validateProductionDayForSubmission({
        timeSlots: slots,
        lines: [
            {
                lineCode: 'CM1',
                configured: true,
                entries: [{ quantity: 0 }],
                slotValues: [{ key: '08:00', runId: 'run-a', reported: true }],
            },
        ],
    });

    assert.equal(result.valid, true);
});

test('khung giờ đã tắt không mang runId và không chặn gửi duyệt (ngày không tăng ca)', () => {
    const slotsWithInactiveOvertime = [
        ...slots,
        { key: '18:00', label: '18h', startMinute: 1080, endMinute: 1140, kind: 'overtime', isActive: false },
    ];
    const detail = buildProductionDayDetail(
        {
            _id: 'day-1',
            plantId: 'plant-1',
            productionDate: '2026-07-20',
            timeSlots: slotsWithInactiveOvertime,
        },
        [
            {
                _id: 'record-1',
                dayId: 'day-1',
                plantId: 'plant-1',
                productionDate: '2026-07-20',
                lineId: 'line-1',
                lineCode: 'CM1',
                workerCount: 20,
                workerCountConfirmedAt: new Date('2026-07-20T00:30:00.000Z'),
                runs, // run-b active, open-ended -> phủ đến hết ngày, kể cả khung 18h đã tắt
                entries: [
                    { _id: 'entry-a', slotKey: '08:00', runId: 'run-a', quantity: 90 },
                    { _id: 'entry-b', slotKey: '09:00', runId: 'run-b', quantity: 80 },
                ],
            },
        ]
    );

    const line = detail.lines[0];
    const inactiveSlot = line.slotValues.find((slot: any) => slot.key === '18:00');
    assert.equal(inactiveSlot?.runId, undefined);
    assert.equal(inactiveSlot?.target, 0);

    const result = validateProductionDayForSubmission(detail);
    assert.equal(result.valid, true, result.message);
});

test('ẩn đơn giá và giá trị sản lượng khỏi payload của nhân viên nhập liệu', () => {
    const redacted = redactProductionFinancials({
        lines: [
            {
                totalAmount: 900_000,
                averageIncome: 90_000,
                runs: [{ id: 'run-1', unitPriceSnapshot: 10_000 }],
                entries: [{ id: 'entry-1', amount: 900_000 }],
            },
        ],
        summary: { totalAmount: 900_000, averageIncome: 90_000 },
    });

    assert.equal(redacted.financialsVisible, false);
    assert.equal(redacted.summary.totalAmount, 0);
    assert.equal('unitPriceSnapshot' in redacted.lines[0].runs[0], false);
    assert.equal('amount' in redacted.lines[0].entries[0], false);
});
