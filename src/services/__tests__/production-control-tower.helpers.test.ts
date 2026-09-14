import {
    buildControlTowerOrder,
    resolveProductionOrderLifecycleStatus,
    summarizeControlTower,
} from '@/services/production-control-tower.helpers';
import assert from 'node:assert/strict';
import test from 'node:test';

const base = (overrides: Record<string, any> = {}) => ({
    order: {
        id: 'order-1',
        code: 'SO-001',
        itemId: 'item-1',
        itemCode: 'A01',
        totalQuantity: 1_000,
        dueDate: '2026-09-20',
        priority: 'normal',
        status: 'in_production',
    },
    progress: {
        producedQuantity: 400,
        remainingQuantity: 600,
        completionPercent: 40,
        futurePlannedQuantity: 400,
        unplannedQuantity: 200,
        lastProductionDate: '2026-09-14',
        activeLineCodes: ['CM1'],
    },
    material: { status: 'ready' as const, reservationStatus: 'reserved' as const, shortageLineCount: 0 },
    dailyActual: [
        { date: '2026-09-12', quantity: 100 },
        { date: '2026-09-13', quantity: 100 },
        { date: '2026-09-14', quantity: 100 },
    ],
    plans: [
        { date: '2026-09-14', quantity: 200, status: 'published' as const },
        { date: '2026-09-15', quantity: 300, status: 'published' as const },
    ],
    today: '2026-09-14',
    ...overrides,
});

test('dự báo dùng phần kế hoạch còn lại hôm nay rồi ngoại suy theo nhịp thực tế', () => {
    const result = buildControlTowerOrder(base());
    assert.equal(result.scheduledQuantity, 400);
    assert.equal(result.forecastDate, '2026-09-17');
    assert.equal(result.forecastConfidence, 'high');
    assert.ok(result.exceptions.some((item) => item.code === 'unplanned_quantity'));
});

test('thiếu vật tư và dự báo trễ được nâng thành ngoại lệ nghiêm trọng', () => {
    const result = buildControlTowerOrder(
        base({
            material: { status: 'shortage', reservationStatus: 'partial', shortageLineCount: 2 },
            order: { ...base().order, dueDate: '2026-09-15' },
        })
    );
    assert.equal(result.forecastStatus, 'late');
    assert.equal(result.severity, 'critical');
    assert.ok(result.exceptions.some((item) => item.code === 'material_shortage'));
});

test('đơn đủ sản lượng được đề xuất hoàn thành và không còn dự báo thiếu', () => {
    const result = buildControlTowerOrder(
        base({
            order: { ...base().order, status: 'in_production' },
            progress: { ...base().progress, producedQuantity: 1_000, remainingQuantity: 0, unplannedQuantity: 0 },
            plans: [],
        })
    );
    assert.equal(result.expectedStatus, 'completed');
    assert.equal(result.forecastStatus, 'completed');
    assert.ok(result.exceptions.some((item) => item.code === 'status_mismatch'));
});

test('đồng bộ vòng đời không thay đổi đơn đã hủy hoặc đang tạm dừng', () => {
    assert.equal(
        resolveProductionOrderLifecycleStatus({
            currentStatus: 'cancelled',
            producedQuantity: 1_000,
            totalQuantity: 1_000,
            futurePlannedQuantity: 0,
        }),
        'cancelled'
    );
    assert.equal(
        resolveProductionOrderLifecycleStatus({
            currentStatus: 'paused',
            producedQuantity: 100,
            totalQuantity: 1_000,
            futurePlannedQuantity: 500,
        }),
        'paused'
    );
});

test('tổng hợp control tower dùng trọng số sản lượng cho độ phủ kế hoạch', () => {
    const first = buildControlTowerOrder(base());
    const second = buildControlTowerOrder(
        base({
            order: { ...base().order, id: 'order-2', code: 'SO-002', totalQuantity: 100 },
            progress: { ...base().progress, producedQuantity: 0, remainingQuantity: 100, unplannedQuantity: 0 },
            dailyActual: [],
            plans: [{ date: '2026-09-15', quantity: 100, status: 'published' }],
        })
    );
    const summary = summarizeControlTower([first, second], '2026-09-14');
    assert.equal(summary.remainingQuantity, 700);
    assert.equal(summary.planCoveragePercent, 71.4);
    assert.equal(summary.actualToday, 100);
});
