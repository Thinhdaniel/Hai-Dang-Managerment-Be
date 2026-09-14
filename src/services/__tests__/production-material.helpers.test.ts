import assert from 'node:assert/strict';
import test from 'node:test';
import {
    calculateBomRequirement,
    calculateMaterialLineReadiness,
    calculateReservableQuantity,
    summarizeMaterialReadiness,
} from '../production-material.helpers';

test('BOM requirement includes wastage and keeps practical precision', () => {
    assert.equal(calculateBomRequirement({ orderQuantity: 1000, quantityPerUnit: 0.32, wastagePercent: 3 }), 329.6);
});

test('reserved stock cannot be counted for two production orders', () => {
    const result = calculateMaterialLineReadiness({
        requiredQuantity: 80,
        onHandQuantity: 100,
        reservedForOrderQuantity: 20,
        totalReservedQuantity: 70,
    });
    assert.equal(result.reservedForOtherOrdersQuantity, 50);
    assert.equal(result.freeQuantity, 30);
    assert.equal(result.availableForOrderQuantity, 50);
    assert.equal(result.shortageQuantity, 30);
    assert.equal(result.status, 'partial');
});

test('unconfirmed inbound is not treated as ready stock', () => {
    const result = calculateMaterialLineReadiness({
        requiredQuantity: 10,
        onHandQuantity: 0,
        reservedForOrderQuantity: 0,
        totalReservedQuantity: 0,
        confirmedInboundQuantity: 0,
    });
    assert.equal(result.shortageQuantity, 10);
    assert.equal(result.status, 'shortage');
});

test('readiness summary reports unknown ETA and latest required ready date', () => {
    const blocked = summarizeMaterialReadiness([
        { isRequired: true, status: 'ready', readyDate: '2026-09-14' },
        { isRequired: true, status: 'partial', inboundQuantity: 20, confirmedInboundQuantity: 0 },
    ]);
    assert.equal(blocked.status, 'partial');
    assert.equal(blocked.unknownInboundLineCount, 1);
    assert.equal(blocked.materialReadyDate, undefined);

    const ready = summarizeMaterialReadiness([
        { isRequired: true, status: 'ready', readyDate: '2026-09-14' },
        { isRequired: true, status: 'ready', readyDate: '2026-09-16' },
    ]);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.materialReadyDate, '2026-09-16');
});

test('reservable quantity respects stock already promised to another order', () => {
    assert.equal(
        calculateReservableQuantity({ requiredQuantity: 100, onHandQuantity: 80, reservedForOtherOrdersQuantity: 35 }),
        45
    );
});
