import { buildProductionForecast } from '@/services/production-forecast.helpers';
import assert from 'node:assert/strict';
import test from 'node:test';

const plan = {
    productionDate: '2026-07-18',
    timeSlots: [
        { key: '08:00', startMinute: 480, endMinute: 540, isActive: true },
        { key: '09:00', startMinute: 540, endMinute: 600, isActive: true },
        { key: '10:00', startMinute: 600, endMinute: 660, isActive: true },
        { key: '11:00', startMinute: 660, endMinute: 720, isActive: true },
    ],
    allocations: [
        {
            id: 'allocation-1',
            lineId: 'line-1',
            lineCode: 'CM1',
            itemId: 'item-1',
            itemCode: 'HD-01',
            plannedQuantity: 400,
            hourlyQuota: 100,
            startSlotKey: '08:00',
            endSlotKey: '11:00',
            priority: 'normal',
        },
    ],
};

const clock = {
    localDate: '2026-07-18',
    minuteOfDay: 600,
    asOf: '2026-07-18T03:00:00.000Z',
};

const detailWithActual = (quantities: number[]) => ({
    lines: [
        {
            lineId: 'line-1',
            runs: [{ id: 'run-1', planAllocationId: 'allocation-1' }],
            entries: quantities.map((quantity, index) => ({
                runId: 'run-1',
                slotKey: index ? '09:00' : '08:00',
                quantity,
            })),
        },
    ],
});

test('dự báo cuối ngày từ tốc độ thực tế và đánh dấu đúng nhịp', () => {
    const forecast = buildProductionForecast(plan, detailWithActual([100, 90]), clock);

    assert.equal(forecast.summary.actualQuantity, 190);
    assert.equal(forecast.summary.expectedToNow, 200);
    assert.equal(forecast.summary.projectedEndOfDay, 380);
    assert.equal(forecast.summary.projectedCompletionPercent, 95);
    assert.equal(forecast.allocations[0].status, 'on_track');
    assert.equal(forecast.alerts.length, 0);
});

test('cảnh báo nghiêm trọng khi nhịp thực tế dưới 80 phần trăm', () => {
    const forecast = buildProductionForecast(plan, detailWithActual([60, 60]), clock);

    assert.equal(forecast.summary.projectedEndOfDay, 240);
    assert.equal(forecast.allocations[0].status, 'behind');
    assert.equal(forecast.alerts[0].severity, 'critical');
    assert.equal(forecast.alerts[0].type, 'plan_at_risk');
});

test('ngày tương lai giữ dự báo bằng kế hoạch và chưa phát cảnh báo', () => {
    const forecast = buildProductionForecast({ ...plan, productionDate: '2026-07-19' }, detailWithActual([]), clock);

    assert.equal(forecast.summary.projectedEndOfDay, 400);
    assert.equal(forecast.allocations[0].status, 'not_started');
    assert.equal(forecast.alerts.length, 0);
});

test('ngày đã khóa thời gian nhưng còn thiếu được xếp quá hạn', () => {
    const forecast = buildProductionForecast(
        { ...plan, productionDate: '2026-07-17' },
        detailWithActual([100, 100]),
        clock
    );

    assert.equal(forecast.allocations[0].status, 'overdue');
    assert.equal(forecast.alerts[0].type, 'plan_overdue');
});
