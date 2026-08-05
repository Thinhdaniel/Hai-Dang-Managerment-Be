import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionMonitor } from '@/services/production-monitor.helpers';

const slots = [
    { key: '08:00', label: '8h', startMinute: 480, endMinute: 540, isActive: true },
    { key: '09:00', label: '9h', startMinute: 540, endMinute: 600, isActive: true },
    { key: '10:00', label: '10h', startMinute: 600, endMinute: 660, isActive: true },
];

const detail: any = {
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

test('tổng hợp realtime công đoạn bắt buộc, tùy chọn và hàng chuyển tiếp độc lập với thành phẩm', () => {
    const withOperations = structuredClone(detail);
    withOperations.lines[0].operationTrackSummaries = [
        {
            id: 'track-neck',
            operationId: 'operation-neck',
            operationCode: 'TRA-CO',
            operationName: 'Tra cổ',
            unit: 'SP',
            itemId: 'item-1',
            itemCode: 'HD-01',
            sourceRunId: 'run-1',
            hourlyQuota: 100,
            required: true,
            sortOrder: 0,
            startedSlotKey: '08:00',
            status: 'active',
        },
        {
            id: 'track-old',
            operationId: 'operation-old',
            operationCode: 'MAY-TAY',
            operationName: 'May tay',
            unit: 'SP',
            itemId: 'item-old',
            itemCode: 'HD-OLD',
            sourceRunId: 'run-old',
            hourlyQuota: 80,
            required: true,
            sortOrder: 1,
            startedSlotKey: '08:00',
            endedSlotKey: '09:00',
            status: 'closed',
        },
    ];
    withOperations.lines[0].operationSlotValues = [
        {
            key: '08:00',
            trackId: 'track-neck',
            due: true,
            required: true,
            target: 100,
            actual: 90,
            reported: true,
            transition: false,
            updatedAt: '2026-07-18T02:01:00.000Z',
            enteredByName: 'Tổ trưởng A',
        },
        {
            key: '09:00',
            trackId: 'track-neck',
            due: true,
            required: true,
            target: 100,
            actual: 0,
            reported: false,
            transition: false,
        },
        {
            key: '10:00',
            trackId: 'track-neck',
            due: true,
            required: true,
            target: 100,
            actual: 0,
            reported: false,
            transition: false,
        },
        {
            key: '10:00',
            trackId: 'track-old',
            due: false,
            required: true,
            target: 0,
            actual: 20,
            reported: true,
            transition: true,
        },
    ];
    withOperations.lines[1].operationTrackSummaries = [
        {
            id: 'track-check',
            operationId: 'operation-check',
            operationCode: 'KIEM-CT',
            operationName: 'Kiểm chi tiết',
            unit: 'SP',
            itemId: 'item-2',
            itemCode: 'HD-02',
            sourceRunId: 'run-2',
            hourlyQuota: 50,
            required: false,
            sortOrder: 0,
            startedSlotKey: '08:00',
            status: 'active',
        },
    ];
    withOperations.lines[1].operationSlotValues = [
        {
            key: '08:00',
            trackId: 'track-check',
            due: true,
            required: false,
            target: 50,
            actual: 45,
            reported: true,
            transition: false,
        },
        {
            key: '09:00',
            trackId: 'track-check',
            due: true,
            required: false,
            target: 50,
            actual: 0,
            reported: false,
            transition: false,
        },
    ];

    const monitor = buildProductionMonitor(withOperations, [], clock);
    const requiredTrack = monitor.operationPerformance.find((operation: any) => operation.trackId === 'track-neck');
    const oldTrack = monitor.operationPerformance.find((operation: any) => operation.trackId === 'track-old');

    assert.equal(monitor.operationSummary.trackCount, 3);
    assert.equal(monitor.operationSummary.expectedEntries, 2);
    assert.equal(monitor.operationSummary.reportedEntries, 1);
    assert.equal(monitor.operationSummary.coveragePercent, 50);
    assert.equal(requiredTrack.status, 'missing');
    assert.equal(requiredTrack.currentSlot.key, '10:00');
    assert.equal(oldTrack.transitionQuantity, 20);
    assert.equal(requiredTrack.actualToNow, 90);
    assert.equal(
        monitor.operationAlerts.some(
            (alert: any) => alert.type === 'missing_operation_report' && alert.slotKey === '09:00'
        ),
        true
    );
    assert.equal(
        monitor.operationAlerts.some(
            (alert: any) => alert.type === 'missing_operation_report' && alert.trackId === 'track-check'
        ),
        false
    );
    assert.equal(monitor.summary.actualToNow, 260);
});

test('ngày chưa có cấu hình công đoạn trả cấu trúc monitor rỗng ổn định', () => {
    const monitor = buildProductionMonitor(detail, [], clock);

    assert.deepEqual(monitor.operationPerformance, []);
    assert.deepEqual(monitor.operationAlerts, []);
    assert.equal(monitor.operationSummary.trackCount, 0);
    assert.equal(monitor.operationSummary.coveragePercent, 100);
});
