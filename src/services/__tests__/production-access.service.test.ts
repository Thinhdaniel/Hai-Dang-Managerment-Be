import { USER_ROLE } from '@/constant/allowedRoles';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateProductionAccess } from '../production-access.service';

describe('production access policy', () => {
    it('allows admin and director across plants even when rollout is disabled', () => {
        for (const role of [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR]) {
            const decision = evaluateProductionAccess({
                role,
                userPlantId: 'plant-1',
                targetPlantId: 'plant-2',
                enabled: false,
            });

            assert.equal(decision.globalAccess, true);
            assert.equal(decision.canAccess, true);
            assert.equal(decision.reason, undefined);
        }
    });

    it('allows an assigned plant user only when Production is enabled', () => {
        const allowed = evaluateProductionAccess({
            role: USER_ROLE.MANAGER,
            userPlantId: 'plant-1',
            targetPlantId: 'plant-1',
            enabled: true,
        });
        const disabled = evaluateProductionAccess({
            role: USER_ROLE.LINE_LEADER,
            userPlantId: 'plant-1',
            targetPlantId: 'plant-1',
            enabled: false,
        });

        assert.equal(allowed.canAccess, true);
        assert.equal(disabled.canAccess, false);
        assert.equal(disabled.reason, 'PRODUCTION_NOT_ENABLED');
    });

    it('never allows a non-global role to switch to another plant', () => {
        const decision = evaluateProductionAccess({
            role: USER_ROLE.MANAGER,
            userPlantId: 'plant-1',
            targetPlantId: 'plant-2',
            enabled: true,
        });

        assert.equal(decision.inPlantScope, false);
        assert.equal(decision.canAccess, false);
        assert.equal(decision.reason, 'PLANT_SCOPE_DENIED');
    });
});
