import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildProductionRolloutReadiness,
    evaluateProductionRolloutTransition,
    normalizeProductionRolloutStage,
} from '../production-rollout.helpers';

const readyInput = {
    activeLines: 4,
    activeItems: 3,
    configuredScheduleDays: 6,
    localManagers: 1,
    lineLeaders: 4,
    qcUsers: 2,
    openOrders: 2,
    approvedBoms: 1,
    publishedPlanDays: 3,
    acceptedPilotCode: 'PILOT-20260914-01',
};

test('legacy enabled plant is inferred as live without breaking current rollout', () => {
    assert.equal(normalizeProductionRolloutStage({ enabled: true }), 'live');
    assert.equal(normalizeProductionRolloutStage({ enabled: false }), 'disabled');
});

test('pilot gate reports every missing preparation item', () => {
    const result = buildProductionRolloutReadiness({
        ...readyInput,
        activeLines: 0,
        lineLeaders: 0,
        acceptedPilotCode: undefined,
    });
    assert.equal(result.pilotReady, false);
    assert.deepEqual(result.pilotBlockers, ['ACTIVE_LINES', 'LINE_LEADER']);
    assert.equal(result.liveBlockers.includes('SIGNED_UAT'), true);
});

test('preparing can enter pilot only after the pilot gate passes', () => {
    const readiness = buildProductionRolloutReadiness(readyInput);
    assert.equal(
        evaluateProductionRolloutTransition({ fromStage: 'preparing', toStage: 'pilot', readiness }).allowed,
        true
    );
});

test('live transition requires published plan and signed UAT', () => {
    const readiness = buildProductionRolloutReadiness({
        ...readyInput,
        publishedPlanDays: 0,
        acceptedPilotCode: undefined,
    });
    const result = evaluateProductionRolloutTransition({ fromStage: 'pilot', toStage: 'live', readiness });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'LIVE_GATE_BLOCKED');
    assert.deepEqual(result.blockers, ['PUBLISHED_PLAN', 'SIGNED_UAT']);
});

test('live can only pause and cannot be silently disabled', () => {
    const readiness = buildProductionRolloutReadiness(readyInput);
    assert.equal(
        evaluateProductionRolloutTransition({ fromStage: 'live', toStage: 'paused', readiness }).allowed,
        true
    );
    assert.equal(
        evaluateProductionRolloutTransition({ fromStage: 'live', toStage: 'disabled', readiness }).allowed,
        false
    );
});
