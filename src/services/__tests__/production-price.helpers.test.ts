import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldProcessProductionPriceUpdate, summarizeProductionPriceCorrection } from '../production-price.helpers';

test('đơn giá danh mục đã đúng vẫn cho phép tính lại snapshot cũ theo ngày', () => {
    assert.equal(
        shouldProcessProductionPriceUpdate({
            priceChanged: false,
            unitPriceMode: 'recalculate_from_date',
            unitPriceEffectiveFrom: '2026-07-21',
        }),
        true
    );
    assert.equal(
        shouldProcessProductionPriceUpdate({
            priceChanged: false,
            unitPriceMode: 'future_only',
        }),
        false
    );
});

test('chỉ tính các run đúng mã hàng và còn dùng đơn giá cũ', () => {
    const impact = summarizeProductionPriceCorrection({
        itemId: 'item-a',
        nextUnitPrice: 12_500,
        records: [
            {
                _id: 'record-1',
                dayId: 'day-1',
                productionDate: '2026-08-10',
                runs: [
                    { _id: 'run-a1', itemId: 'item-a', unitPriceSnapshot: 10_000 },
                    { _id: 'run-a2', itemId: 'item-a', unitPriceSnapshot: 12_500 },
                    { _id: 'run-b1', itemId: 'item-b', unitPriceSnapshot: 9_000 },
                ],
                entries: [
                    { runId: 'run-a1', slotKey: '08:00' },
                    { runId: 'run-a1', slotKey: '09:00' },
                    { runId: 'run-a2', slotKey: '10:00' },
                    { runId: 'run-b1', slotKey: '11:00' },
                ],
            },
            {
                _id: 'record-2',
                dayId: 'day-2',
                productionDate: '2026-08-11',
                runs: [{ _id: 'run-a3', itemId: 'item-a', unitPriceSnapshot: 8_000 }],
                entries: [{ runId: 'run-a3', slotKey: '08:00' }],
            },
        ],
        plans: [
            {
                _id: 'plan-1',
                allocations: [
                    { itemId: 'item-a', unitPriceSnapshot: 10_000 },
                    { itemId: 'item-a', unitPriceSnapshot: 12_500 },
                    { itemId: 'item-b', unitPriceSnapshot: 5_000 },
                ],
            },
        ],
    });

    assert.deepEqual(impact.recordIds, ['record-1', 'record-2']);
    assert.deepEqual(impact.dayIds, ['day-1', 'day-2']);
    assert.deepEqual(impact.productionDates, ['2026-08-10', '2026-08-11']);
    assert.equal(impact.affectedRecordCount, 2);
    assert.equal(impact.affectedDayCount, 2);
    assert.equal(impact.affectedRunCount, 2);
    assert.equal(impact.affectedEntryCount, 3);
    assert.equal(impact.affectedPlanCount, 1);
    assert.equal(impact.affectedPlanAllocationCount, 1);
});

test('không báo ảnh hưởng khi mọi snapshot đã bằng đơn giá mới', () => {
    const impact = summarizeProductionPriceCorrection({
        itemId: 'item-a',
        nextUnitPrice: 12_500,
        records: [
            {
                _id: 'record-1',
                dayId: 'day-1',
                productionDate: '2026-08-11',
                runs: [{ _id: 'run-a1', itemId: 'item-a', unitPriceSnapshot: 12_500 }],
                entries: [{ runId: 'run-a1' }],
            },
        ],
        plans: [{ _id: 'plan-1', allocations: [{ itemId: 'item-a', unitPriceSnapshot: 12_500 }] }],
    });

    assert.equal(impact.affectedRecordCount, 0);
    assert.equal(impact.affectedRunCount, 0);
    assert.equal(impact.affectedEntryCount, 0);
    assert.equal(impact.affectedPlanAllocationCount, 0);
});
