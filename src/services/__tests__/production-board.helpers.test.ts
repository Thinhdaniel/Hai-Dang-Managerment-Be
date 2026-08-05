import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionBoard } from '@/services/production-board.helpers';

const detail: any = {
    id: 'day-1',
    plantId: 'plant-1',
    plantName: 'Cơ sở 1',
    plantCode: 'CS1',
    productionDate: '2026-07-20',
    status: 'draft',
    updatedAt: '2026-07-20T03:01:00.000Z',
    timeSlots: [
        { key: '08:00', label: '08:00–09:00', startMinute: 480, endMinute: 540, isActive: true },
        { key: '09:00', label: '09:00–10:00', startMinute: 540, endMinute: 600, isActive: true },
        { key: '10:00', label: '10:00–11:00', startMinute: 600, endMinute: 660, isActive: true },
    ],
    lines: [
        {
            lineId: 'line-1',
            lineCode: 'C1',
            lineName: 'Chuyền 1',
            leaderName: 'Tổ trưởng A',
            workerCount: 10,
            configured: true,
            updatedAt: '2026-07-20T03:01:00.000Z',
            runs: [
                {
                    id: 'run-1',
                    itemCode: 'HD-01',
                    itemName: 'Áo mẫu 1',
                    orderCode: 'PO-01',
                    unitPriceSnapshot: 1_000,
                    hourlyQuota: 100,
                },
                {
                    id: 'run-2',
                    itemCode: 'HD-02',
                    itemName: 'Áo mẫu 2',
                    orderCode: 'PO-02',
                    unitPriceSnapshot: 2_000,
                    hourlyQuota: 50,
                },
            ],
            entries: [
                { id: 'entry-1', slotKey: '08:00', runId: 'run-1', quantity: 90, amount: 90_000 },
                { id: 'entry-2', slotKey: '09:00', runId: 'run-1', quantity: 110, amount: 110_000 },
            ],
            slotValues: [
                { key: '08:00', runId: 'run-1', target: 100, actual: 90, reported: true },
                { key: '09:00', runId: 'run-1', target: 100, actual: 110, reported: true },
                { key: '10:00', runId: 'run-2', target: 50, actual: 0, reported: false },
            ],
        },
    ],
};

const clock = {
    localDate: '2026-07-20',
    minuteOfDay: 630,
    asOf: '2026-07-20T03:30:00.000Z',
};

test('tính khoán chính xác đến phút nhưng chỉ cảnh báo theo các giờ đã chốt', () => {
    const board = buildProductionBoard(structuredClone(detail), clock);
    const line = board.lines[0];

    assert.equal(line.checkpoint.target, 200);
    assert.equal(line.checkpoint.actual, 200);
    assert.equal(line.checkpoint.achievementPercent, 100);
    assert.equal(line.live.targetToNow, 225);
    assert.equal(line.live.actualToNow, 200);
    assert.equal(line.status, 'on_track');
    assert.equal(line.currentSlot?.remainingMinutes, 30);
    assert.equal(line.currentSlot?.requiredQuantity, 50);
    assert.equal(line.currentSlot?.basePer15, 12.5);
});

test('dùng đúng đơn giá snapshot của từng mã để tính thu nhập và dự báo', () => {
    const board = buildProductionBoard(structuredClone(detail), clock);
    const line = board.lines[0];

    assert.equal(line.day.targetAmount, 300_000);
    assert.equal(line.day.actualAmount, 200_000);
    assert.equal(line.day.averageIncome, 20_000);
    assert.equal(line.day.targetAverageIncome, 30_000);
    assert.equal(line.day.projectedAmount, 300_000);
    assert.equal(line.day.projectedAverageIncome, 30_000);
    assert.equal(line.activeItem?.itemCode, 'HD-02');
    assert.equal(line.activeItem?.unitPrice, 2_000);
});

test('thiếu báo cáo được tách khỏi cảnh báo chậm sản lượng và không dự báo thu nhập sai', () => {
    const input = structuredClone(detail);
    input.lines[0].entries = input.lines[0].entries.slice(0, 1);
    input.lines[0].slotValues[1].actual = 0;
    input.lines[0].slotValues[1].reported = false;
    const line = buildProductionBoard(input, clock).lines[0];

    assert.equal(line.status, 'missing');
    assert.deepEqual(line.missingSlots, ['09:00']);
    assert.equal(line.day.projectedAmount, undefined);
    assert.match(line.guidance.title, /thiếu báo cáo/i);
});

test('cộng phần hụt của các giờ trước vào nhịp cần đạt của giờ hiện tại', () => {
    const input = structuredClone(detail);
    input.lines[0].entries[0].quantity = 60;
    input.lines[0].entries[0].amount = 60_000;
    input.lines[0].entries[1].quantity = 80;
    input.lines[0].entries[1].amount = 80_000;
    input.lines[0].slotValues[0].actual = 60;
    input.lines[0].slotValues[1].actual = 80;
    const line = buildProductionBoard(input, clock).lines[0];

    assert.equal(line.status, 'critical');
    assert.equal(line.checkpoint.gap, -60);
    assert.equal(line.currentSlot?.carryShortfall, 60);
    assert.equal(line.currentSlot?.requiredQuantity, 110);
    assert.equal(line.currentSlot?.requiredPer15, 27.5);
});

test('hiển thị riêng sản lượng và giá trị vượt toàn bộ khoán ngày', () => {
    const input = structuredClone(detail);
    input.lines[0].entries.push({
        id: 'entry-3',
        slotKey: '10:00',
        runId: 'run-2',
        quantity: 70,
        amount: 140_000,
    });
    input.lines[0].slotValues[2].actual = 70;
    input.lines[0].slotValues[2].reported = true;
    const line = buildProductionBoard(input, clock).lines[0];

    assert.equal(line.day.overQuotaQuantity, 20);
    assert.equal(line.day.overQuotaAmount, 40_000);
    assert.equal(line.day.actualAmount, 340_000);
});

test('trước giờ sản xuất hiển thị mã hàng đầu tiên và không cảnh báo hụt khoán', () => {
    const line = buildProductionBoard(structuredClone(detail), { ...clock, minuteOfDay: 450 }).lines[0];

    assert.equal(line.status, 'waiting');
    assert.equal(line.activeItem?.itemCode, 'HD-01');
    assert.equal(line.checkpoint.target, 0);
    assert.equal(line.day.projectedAverageIncome, undefined);
});

test('bảng chuyền hiển thị tín hiệu công đoạn nhưng không làm thay đổi tổng thành phẩm', () => {
    const input = structuredClone(detail);
    input.lines[0].operationTrackSummaries = [
        {
            id: 'track-neck',
            operationCode: 'TRA-CO',
            operationName: 'Tra cổ',
            itemCode: 'HD-01',
            unit: 'SP',
            required: true,
            sortOrder: 0,
        },
    ];
    input.lines[0].operationSlotValues = [
        {
            key: '08:00',
            trackId: 'track-neck',
            due: true,
            target: 100,
            actual: 40,
            reported: true,
        },
        {
            key: '09:00',
            trackId: 'track-neck',
            due: true,
            target: 100,
            actual: 0,
            reported: false,
        },
        {
            key: '10:00',
            trackId: 'track-neck',
            due: true,
            target: 100,
            actual: 0,
            reported: false,
        },
    ];

    const board = buildProductionBoard(input, clock);
    const line = board.lines[0];

    assert.equal(line.operations.trackedCount, 1);
    assert.equal(line.operations.missingCount, 1);
    assert.equal(line.operations.behindCount, 1);
    assert.equal(line.operations.items[0].status, 'missing');
    assert.equal(line.operations.currentCount, 1);
    assert.equal(board.summary.operationTrackCount, 1);
    assert.equal(board.summary.operationCoveragePercent, 50);
    assert.equal(board.summary.actual, 200);
});
