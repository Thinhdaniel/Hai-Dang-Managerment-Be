import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionMonitor } from '@/services/production-monitor.helpers';

const slots = [
    { key: '08:00', label: '8h', startMinute: 480, endMinute: 540, isActive: true },
    { key: '09:00', label: '9h', startMinute: 540, endMinute: 600, isActive: true },
    { key: '10:00', label: '10h', startMinute: 600, endMinute: 660, isActive: true },
];

const detail = {
    productionDate: '2026-07-18',
    timeSlots: slots,
    summary: { totalTarget: 500, totalActual: 400 },
    lines: [
        {
            lineId: 'line-1',
            lineCode: 'CM1',
            configured: true,
            workerCount: 12,
            entries: [{ slotKey: '08:00', quantity: 90, note: '' }],
            slotValues: [
                { key: '08:00', runId: 'run-1', target: 100, actual: 90, reported: true },
                { key: '09:00', runId: 'run-1', target: 100, actual: 0, reported: false },
                { key: '10:00', runId: 'run-1', target: 100, actual: 0, reported: false },
            ],
        },
        {
            lineId: 'line-2',
            lineCode: 'CM2',
            configured: true,
            workerCount: 10,
            entries: [
                { slotKey: '08:00', quantity: 0, note: '' },
                { slotKey: '09:00', quantity: 170, note: '' },
            ],
            slotValues: [
                { key: '08:00', runId: 'run-2', target: 100, actual: 0, reported: true },
                { key: '09:00', runId: 'run-2', target: 100, actual: 170, reported: true },
                { key: '10:00', runId: 'run-2', target: 100, actual: 0, reported: false },
            ],
        },
    ],
};

const clock = {
    localDate: '2026-07-18',
    minuteOfDay: 610,
    asOf: '2026-07-18T03:10:00.000Z',
};

test('chỉ đánh giá khung giờ đã kết thúc và không cảnh báo khung đang chạy', () => {
    const monitor = buildProductionMonitor(detail, [], clock);

    assert.deepEqual(monitor.dueSlotKeys, ['08:00', '09:00']);
    assert.equal(monitor.currentSlotKey, '10:00');
    assert.equal(
        monitor.alerts.some((alert) => alert.slotKey === '10:00'),
        false
    );
    assert.equal(monitor.summary.dueSlots, 4);
    assert.equal(monitor.summary.reportedSlots, 3);
    assert.equal(monitor.summary.reportingRate, 75);
});

test('phân loại đúng thiếu báo, sản lượng 0 thiếu ghi chú và đột biến nhập liệu', () => {
    const monitor = buildProductionMonitor(detail, [], clock);

    assert.equal(
        monitor.alerts.some((alert) => alert.type === 'missing_report' && alert.lineCode === 'CM1'),
        true
    );
    assert.equal(
        monitor.alerts.some((alert) => alert.type === 'zero_without_note' && alert.lineCode === 'CM2'),
        true
    );
    assert.equal(
        monitor.alerts.some((alert) => alert.type === 'output_spike' && alert.lineCode === 'CM2'),
        true
    );
    assert.equal(monitor.linePerformance.find((line: any) => line.lineCode === 'CM1')?.status, 'missing');
    assert.equal(monitor.linePerformance.find((line: any) => line.lineCode === 'CM2')?.status, 'critical');
});

test('ghi chú hợp lệ loại bỏ cảnh báo sản lượng 0 và nền chỉ dùng ngày được truyền vào', () => {
    const withNote = structuredClone(detail);
    withNote.lines[1].entries[0].note = 'Dừng chuyền thay kim';
    const baseline = {
        lines: [
            { lineId: 'line-1', totalTarget: 200, totalActual: 200 },
            { lineId: 'line-2', totalTarget: 200, totalActual: 160 },
        ],
        summary: { totalTarget: 400, totalActual: 360 },
    };
    const monitor = buildProductionMonitor(withNote, [baseline], clock);

    assert.equal(
        monitor.alerts.some((alert) => alert.type === 'zero_without_note'),
        false
    );
    assert.equal(monitor.summary.baselineDays, 1);
    assert.equal(monitor.summary.baselineAchievement, 90);
    assert.equal(monitor.linePerformance.find((line: any) => line.lineCode === 'CM1')?.baselineAchievement, 100);
});

test('chưa đến khung giờ đầu tiên thì chuyền ở trạng thái chờ, không bị đánh dấu hụt khoán', () => {
    const earlyMonitor = buildProductionMonitor(detail, [], {
        ...clock,
        minuteOfDay: 470,
    });

    assert.equal(earlyMonitor.summary.dueSlots, 0);
    assert.equal(
        earlyMonitor.linePerformance.every((line: any) => line.status === 'waiting'),
        true
    );
    assert.equal(earlyMonitor.alerts.length, 0);
});

test('ngày quá khứ và tương lai không gắn nhầm khung giờ đang chạy', () => {
    const past = buildProductionMonitor({ ...structuredClone(detail), productionDate: '2026-07-17' }, [], clock);
    const future = buildProductionMonitor({ ...structuredClone(detail), productionDate: '2026-07-19' }, [], clock);

    assert.equal(past.currentSlotKey, undefined);
    assert.equal(future.currentSlotKey, undefined);
});
