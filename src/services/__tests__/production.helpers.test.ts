import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionBoard } from '@/services/production-board.helpers';
import {
    buildProductionDayDetail,
    buildTimeSlotLabel,
    decideProductionEntrySync,
    findProductionRunStartConflicts,
    redactProductionFinancials,
    resolveRunForSlot,
    validateProductionDayForSubmission,
} from '@/services/production.helpers';

test('nhãn khung giờ sinh từ mốc phút, có xử lý ca lẻ phút', () => {
    assert.equal(buildTimeSlotLabel(420, 480), '7-8h');
    assert.equal(buildTimeSlotLabel(780, 840), '13-14h');
    assert.equal(buildTimeSlotLabel(1080, 1140), '18-19h');
    // Ca lẻ phút phải ghi rõ phút, không được làm tròn mất thông tin
    assert.equal(buildTimeSlotLabel(450, 510), '7h30-8h30');
    assert.equal(buildTimeSlotLabel(480, 510), '8h-8h30');
});

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

test('không cho đổi mã ngược vào khung đã có sản lượng', () => {
    const entries = [
        { slotKey: '08:00', runId: 'run-a', quantity: 90 },
        { slotKey: '09:00', runId: 'run-a', quantity: 80 },
    ];

    assert.deepEqual(findProductionRunStartConflicts(entries, '08:00', slots), ['08:00', '09:00']);
    assert.deepEqual(findProductionRunStartConflicts(entries, '09:00', slots), ['09:00']);
});

test('bản ghi sản lượng giữ đúng mã và đơn giá lịch sử khi khoảng run từng bị ghi đè', () => {
    const overlapSlots = [
        ...slots,
        { key: '10:00', label: '10h', startMinute: 570, endMinute: 630, kind: 'regular', isActive: true },
    ];
    const detail = buildProductionDayDetail(
        {
            _id: 'day-overlap',
            plantId: 'plant-1',
            productionDate: '2026-07-28',
            timeSlots: overlapSlots,
        },
        [
            {
                _id: 'record-overlap',
                dayId: 'day-overlap',
                plantId: 'plant-1',
                productionDate: '2026-07-28',
                lineId: 'line-56',
                lineCode: 'CM5+6',
                workerCount: 27,
                runs: [
                    {
                        ...runs[0],
                        endedSlotKey: '08:00',
                        hourlyQuota: 200,
                        unitPriceSnapshot: 15_210,
                    },
                    {
                        ...runs[1],
                        startedSlotKey: '08:00',
                        hourlyQuota: 200,
                        unitPriceSnapshot: 5_350,
                    },
                ],
                entries: [
                    { _id: 'entry-08', slotKey: '08:00', runId: 'run-a', quantity: 150 },
                    { _id: 'entry-09', slotKey: '09:00', runId: 'run-a', quantity: 160 },
                ],
            },
        ]
    );

    const line = detail.lines[0];
    assert.equal(line.slotValues[0].runId, 'run-a');
    assert.equal(line.slotValues[1].runId, 'run-a');
    assert.equal(line.slotValues[2].runId, 'run-b');
    assert.equal(line.totalTarget, 500);
    assert.equal(line.totalAmount, 4_715_100);

    const boardLine = buildProductionBoard(detail, {
        localDate: '2026-07-28',
        minuteOfDay: 700,
        asOf: '2026-07-28T04:40:00.000Z',
    }).lines[0];
    assert.equal(boardLine.day.targetAmount, 5_633_000);
    assert.equal(boardLine.day.actualAmount, 4_715_100);
    assert.equal(boardLine.day.targetAverageIncome, 208_630);
    assert.ok((boardLine.day.projectedAverageIncome || 0) < boardLine.day.targetAverageIncome);
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

test('retry cùng clientMutationId là idempotent, không ghi lại ô sản lượng', () => {
    const decision = decideProductionEntrySync(
        {
            updatedAt: '2026-07-24T02:00:00.000Z',
            lastClientMutationId: 'entry-device-a-001',
        },
        {
            clientMutationId: 'entry-device-a-001',
            expectedUpdatedAt: null,
            hasExpectedUpdatedAt: true,
        }
    );

    assert.deepEqual(decision, { action: 'idempotent' });
});

test('phát hiện thiết bị khác đã tạo ô mà client offline vẫn nghĩ là chưa có', () => {
    const decision = decideProductionEntrySync(
        { updatedAt: '2026-07-24T02:00:00.000Z' },
        {
            clientMutationId: 'entry-device-b-001',
            expectedUpdatedAt: null,
            hasExpectedUpdatedAt: true,
        }
    );

    assert.deepEqual(decision, { action: 'conflict', reason: 'created-remotely' });
});

test('cho cập nhật khi expectedUpdatedAt khớp dữ liệu chuẩn trên server', () => {
    const decision = decideProductionEntrySync(
        { updatedAt: new Date('2026-07-24T02:00:00.000Z') },
        {
            clientMutationId: 'entry-device-a-002',
            expectedUpdatedAt: '2026-07-24T02:00:00.000Z',
            hasExpectedUpdatedAt: true,
        }
    );

    assert.deepEqual(decision, { action: 'write' });
});

test('chặn ghi đè khi phiên bản server mới hơn phiên bản thiết bị đã đọc', () => {
    const decision = decideProductionEntrySync(
        { updatedAt: '2026-07-24T02:05:00.000Z' },
        {
            clientMutationId: 'entry-device-a-003',
            expectedUpdatedAt: '2026-07-24T02:00:00.000Z',
            hasExpectedUpdatedAt: true,
        }
    );

    assert.deepEqual(decision, { action: 'conflict', reason: 'updated-remotely' });
});

test('chặn khôi phục âm thầm khi ô đã bị xóa trên server', () => {
    const decision = decideProductionEntrySync(null, {
        clientMutationId: 'entry-device-a-004',
        expectedUpdatedAt: '2026-07-24T02:00:00.000Z',
        hasExpectedUpdatedAt: true,
    });

    assert.deepEqual(decision, { action: 'conflict', reason: 'deleted-remotely' });
});

test('payload client cũ không có expectedUpdatedAt vẫn giữ hành vi ghi hiện tại', () => {
    const decision = decideProductionEntrySync(
        { updatedAt: '2026-07-24T02:00:00.000Z' },
        {
            clientMutationId: undefined,
            expectedUpdatedAt: undefined,
            hasExpectedUpdatedAt: false,
        }
    );

    assert.deepEqual(decision, { action: 'write' });
});

test('ngày đang nhập là báo cáo tạm tính và dataAsOf lấy lần sửa chuyền mới nhất', () => {
    const detail = buildProductionDayDetail(
        {
            _id: 'day-sync',
            plantId: 'plant-1',
            productionDate: '2026-07-24',
            status: 'draft',
            updatedAt: new Date('2026-07-24T01:00:00.000Z'),
            timeSlots: slots,
        },
        [
            {
                _id: 'record-sync',
                dayId: 'day-sync',
                plantId: 'plant-1',
                productionDate: '2026-07-24',
                lineId: 'line-1',
                lineCode: 'CM1',
                workerCount: 20,
                workerCountConfirmedAt: new Date('2026-07-24T00:30:00.000Z'),
                updatedAt: new Date('2026-07-24T03:15:00.000Z'),
                runs,
                entries: [],
            },
        ]
    );

    assert.equal(detail.reportingState, 'provisional');
    assert.equal(detail.dataAsOf, '2026-07-24T03:15:00.000Z');
});

test('ngày đã khóa được đánh dấu là báo cáo chính thức', () => {
    const detail = buildProductionDayDetail(
        {
            _id: 'day-locked',
            plantId: 'plant-1',
            productionDate: '2026-07-24',
            status: 'locked',
            updatedAt: new Date('2026-07-24T04:00:00.000Z'),
            timeSlots: slots,
        },
        []
    );

    assert.equal(detail.reportingState, 'official');
    assert.equal(detail.dataAsOf, '2026-07-24T04:00:00.000Z');
});
