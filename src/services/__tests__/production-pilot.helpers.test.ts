import assert from 'node:assert/strict';
import test from 'node:test';
import {
    comparePilotMetric,
    countPilotWorkingDays,
    evaluatePilotDay,
    summarizeProductionPilot,
    type PilotThresholds,
} from '../production-pilot.helpers';

const thresholds: PilotThresholds = {
    minimumShadowDays: 10,
    quantityVariancePercent: 2,
    capacityVariancePoints: 3,
    countVariance: 0,
};

const metrics = {
    actualOutput: 1000,
    plannedOutput: 1100,
    openOrders: 5,
    capacityUtilizationPercent: 86,
    materialBlockedOrders: 1,
    forecastLateOrders: 2,
};

test('quantity metric uses percentage tolerance', () => {
    assert.equal(comparePilotMetric('actualOutput', 1019, 1000, thresholds).passed, true);
    assert.equal(comparePilotMetric('actualOutput', 1021, 1000, thresholds).passed, false);
});

test('shadow run counts Monday through Saturday and excludes Sunday', () => {
    assert.equal(countPilotWorkingDays('2026-09-14', '2026-09-25'), 11);
});

test('count metric requires exact match by default', () => {
    assert.equal(comparePilotMetric('openOrders', 5, 5, thresholds).passed, true);
    assert.equal(comparePilotMetric('openOrders', 6, 5, thresholds).passed, false);
});

test('day cannot pass without both evidence sources', () => {
    assert.equal(
        evaluatePilotDay({ date: '2026-09-14', systemSnapshot: metrics }, thresholds).status,
        'pending_reference'
    );
    assert.equal(evaluatePilotDay({ date: '2026-09-14', reference: metrics }, thresholds).status, 'pending_system');
});

test('documented variance can be accepted without hiding comparisons', () => {
    const result = evaluatePilotDay(
        {
            date: '2026-09-14',
            systemSnapshot: metrics,
            reference: { ...metrics, actualOutput: 900 },
            varianceAccepted: true,
        },
        thresholds
    );
    assert.equal(result.status, 'accepted_variance');
    assert.equal(result.passed, true);
    assert.equal(result.comparisons.find((row) => row.key === 'actualOutput')?.passed, false);
});

test('signoff gate requires ten reconciled days, checklist and no blocking limitation', () => {
    const dates = ['14', '15', '16', '17', '18', '19', '21', '22', '23', '24'];
    const days = dates.map((date) => ({
        date: `2026-09-${date}`,
        systemSnapshot: metrics,
        reference: metrics,
    }));
    const base = summarizeProductionPilot({
        days,
        checklist: [{ mandatory: true, status: 'passed' }],
        limitations: [],
        thresholds,
    });
    assert.equal(base.eligibleForSignoff, true);
    const blocked = summarizeProductionPilot({
        days,
        checklist: [{ mandatory: true, status: 'passed' }],
        limitations: [{ severity: 'high', status: 'open' }],
        thresholds,
    });
    assert.equal(blocked.eligibleForSignoff, false);
});

test('Sunday evidence is retained but does not count toward the shadow-run gate', () => {
    const days = Array.from({ length: 10 }, (_, index) => ({
        date: `2026-09-${String(index + 1).padStart(2, '0')}`,
        systemSnapshot: metrics,
        reference: metrics,
    }));
    const summary = summarizeProductionPilot({
        days,
        checklist: [{ mandatory: true, status: 'passed' }],
        limitations: [],
        thresholds,
    });
    assert.equal(summary.reconciledDays, 9);
    assert.equal(summary.eligibleForSignoff, false);
});
