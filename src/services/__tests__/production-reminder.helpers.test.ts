import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildProductionReminderCopy,
    buildProductionReminderBucketKey,
    evaluateProductionReminderSlots,
    getProductionLocalDate,
    productionMinuteToDate,
    shouldNotifyProductionPerformance,
} from '@/services/production-reminder.helpers';

const timeSlots = [
    { key: '08:00', label: '8h-9h', startMinute: 480, endMinute: 540, kind: 'regular', isActive: true },
    { key: '09:00', label: '9h-10h', startMinute: 540, endMinute: 600, kind: 'regular', isActive: true },
    { key: '18:00', label: '18h-19h', startMinute: 1080, endMinute: 1140, kind: 'overtime', isActive: true },
];

const day = {
    _id: 'day-1',
    plantId: 'plant-1',
    productionDate: '2026-08-01',
    status: 'draft',
    timeSlots,
};

const records = [
    {
        lineId: 'line-1',
        lineCode: 'CM1',
        workerCountConfirmedAt: '2026-08-01T00:30:00.000Z',
        runs: [{ _id: 'run-1', startedSlotKey: '08:00', hourlyQuota: 100 }],
        entries: [{ slotKey: '08:00', runId: 'run-1', quantity: 75 }],
    },
    {
        lineId: 'line-2',
        lineCode: 'CM2',
        workerCountConfirmedAt: '2026-08-01T00:30:00.000Z',
        runs: [{ _id: 'run-2', startedSlotKey: '08:00', hourlyQuota: 120 }],
        entries: [],
    },
    {
        lineId: 'line-unconfigured',
        lineCode: 'CM3',
        runs: [],
        entries: [],
    },
];

test('không nhắc trước khi khung giờ kết thúc cộng thời gian ân hạn', () => {
    const result = evaluateProductionReminderSlots(day, records, new Date('2026-08-01T02:01:59.000Z'), {
        graceMinutes: 2,
    });
    assert.equal(result.length, 0);
});

test('chỉ đòi báo các chuyền đã cấu hình và có mã chạy trong khung đến hạn', () => {
    const result = evaluateProductionReminderSlots(day, records, new Date('2026-08-01T02:03:00.000Z'), {
        graceMinutes: 2,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].slotKey, '08:00');
    assert.equal(result[0].dueLineCount, 2);
    assert.deepEqual(
        result[0].missingLines.map((line) => line.lineCode),
        ['CM2']
    );
    assert.equal(result[0].reportedLineCount, 1);
});

test('chỉ cảnh báo dưới khoán sau khi toàn bộ chuyền đã báo', () => {
    const fullyReported = structuredClone(records);
    fullyReported[1].entries = [{ slotKey: '08:00', runId: 'run-2', quantity: 120 }];
    const result = evaluateProductionReminderSlots(day, fullyReported, new Date('2026-08-01T02:03:00.000Z'), {
        graceMinutes: 2,
        underTargetEnabled: true,
        underTargetThreshold: 80,
    });

    assert.deepEqual(result[0].missingLines, []);
    assert.deepEqual(
        result[0].underTargetLines.map((line) => line.lineCode),
        ['CM1']
    );
    assert.equal(result[0].underTargetLines[0].achievementPercent, 75);
});

test('nhắc việc dùng cùng khoán nguyên cho hai khung 30 phút', () => {
    const halfHourDay = {
        ...day,
        timeSlots: [
            { key: '14:00', startMinute: 840, endMinute: 870, kind: 'regular', isActive: true },
            { key: '14:30', startMinute: 870, endMinute: 900, kind: 'regular', isActive: true },
        ],
    };
    const halfHourRecords = [
        {
            lineId: 'line-1',
            lineCode: 'CM1',
            workerCountConfirmedAt: '2026-08-01T00:30:00.000Z',
            runs: [{ _id: 'run-1', startedSlotKey: '14:00', hourlyQuota: 15 }],
            entries: [
                { slotKey: '14:00', runId: 'run-1', quantity: 0 },
                { slotKey: '14:30', runId: 'run-1', quantity: 0 },
            ],
        },
    ];

    const result = evaluateProductionReminderSlots(halfHourDay, halfHourRecords, new Date('2026-08-01T08:01:00.000Z'), {
        graceMinutes: 0,
        underTargetEnabled: true,
    });

    assert.deepEqual(
        result.map((slot) => slot.underTargetLines[0]?.target),
        [7, 8]
    );
    assert.deepEqual(
        result.map((slot) => slot.reportedLineCount),
        [1, 1]
    );
});

test('vẫn nhắc công đoạn bắt buộc khi sản lượng tổng của chuyền đã báo đủ', () => {
    const operationRecords = [
        {
            lineId: 'line-1',
            lineCode: 'CM1',
            workerCountConfirmedAt: '2026-08-01T00:30:00.000Z',
            runs: [{ _id: 'run-1', startedSlotKey: '08:00', hourlyQuota: 100 }],
            entries: [{ slotKey: '08:00', runId: 'run-1', quantity: 100 }],
            operationTracks: [
                {
                    _id: 'track-1',
                    operationCode: 'TRA-CO',
                    operationName: 'Tra cổ',
                    itemCode: 'HD-01',
                    required: true,
                    startedSlotKey: '08:00',
                },
            ],
            operationEntries: [],
        },
    ];
    const result = evaluateProductionReminderSlots(day, operationRecords, new Date('2026-08-01T02:03:00.000Z'), {
        graceMinutes: 2,
    });

    assert.deepEqual(result[0].missingLines, []);
    assert.equal(result[0].missingOperations.length, 1);
    assert.equal(result[0].missingOperations[0].label, 'CM1 · TRA-CO · HD-01');
    const copy = buildProductionReminderCopy(result, false);
    assert.match(copy.title, /1 công đoạn/);
    assert.match(copy.message, /TRA-CO/);
});

test('khung tăng ca không dùng khoán nên không sinh cảnh báo hiệu suất giả', () => {
    const overtimeRecords = records.map((record) => ({
        ...structuredClone(record),
        entries: [{ slotKey: '18:00', runId: record.runs[0]?._id, quantity: 10 }],
    }));
    const result = evaluateProductionReminderSlots(day, overtimeRecords, new Date('2026-08-01T12:03:00.000Z'), {
        graceMinutes: 2,
        underTargetEnabled: true,
        underTargetThreshold: 80,
    });
    const overtime = result.find((slot) => slot.slotKey === '18:00');

    assert.ok(overtime);
    assert.deepEqual(overtime.underTargetLines, []);
});

test('ngày và mốc phút luôn tính theo múi giờ Việt Nam', () => {
    assert.equal(getProductionLocalDate(new Date('2026-07-31T17:01:00.000Z')), '2026-08-01');
    assert.equal(productionMinuteToDate('2026-08-01', 540).toISOString(), '2026-08-01T02:00:00.000Z');
});

test('khóa phân tán theo từng phút không làm trễ mốc ân hạn', () => {
    const first = buildProductionReminderBucketKey(new Date('2026-08-01T02:01:00.000Z'), 1);
    const second = buildProductionReminderBucketKey(new Date('2026-08-01T02:02:00.000Z'), 1);

    assert.notEqual(first, second);
});

test('không gửi dồn cảnh báo hiệu suất cũ khi server vừa thức hoặc vừa deploy', () => {
    const recentSlot = {
        slotKey: '08:00',
        slotLabel: '8h-9h',
        dueAt: new Date(),
        overdueMinutes: 7,
        dueLineCount: 1,
        reportedLineCount: 1,
        missingLines: [],
        missingOperations: [],
        underTargetLines: [{ lineId: 'line-1', lineCode: 'CM1', actual: 70, target: 100, achievementPercent: 70 }],
    };

    assert.equal(shouldNotifyProductionPerformance(recentSlot, 5, false), true);
    assert.equal(shouldNotifyProductionPerformance({ ...recentSlot, overdueMinutes: 90 }, 5, false), false);
    assert.equal(shouldNotifyProductionPerformance(recentSlot, 5, true), false);
});

test('nội dung nhắc gộp chuyền và trỏ vào khung cũ nhất', () => {
    const result = evaluateProductionReminderSlots(day, records, new Date('2026-08-01T03:03:00.000Z'), {
        graceMinutes: 2,
    });
    const copy = buildProductionReminderCopy(
        result.filter((slot) => slot.missingLines.length > 0),
        true
    );

    assert.equal(copy.oldestSlotKey, '08:00');
    assert.match(copy.title, /Quá hạn nhập sản lượng/);
    assert.match(copy.message, /CM2/);
});
