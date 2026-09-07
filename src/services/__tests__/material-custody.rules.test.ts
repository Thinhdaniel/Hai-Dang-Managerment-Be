import assert from 'node:assert/strict';
import test from 'node:test';
import { USER_ROLE } from '@/constant/allowedRoles';
import {
    assertCustodyQuantity,
    assertInternalPlantAccess,
    custodyDueDate,
    assertCustodyOccurredAt,
    takeReferenceValue,
    addReferenceValue,
} from '../material-custody.rules';
import { finalizeInternalDraftSchema } from '@/validations/distribution.validation';
import { classifyMaterialRecallDue } from '../material-custody-reminder.helpers';

test('serialized operations reject fractions, zero and nonfinite amounts', () => {
    for (const value of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => assertCustodyQuantity(value, 'serialized'));
    assert.doesNotThrow(() => assertCustodyQuantity(2, 'serialized', 2));
    assert.throws(() => assertCustodyQuantity(3, 'serialized', 2));
    assert.throws(() => assertCustodyQuantity(0.0000001, 'quantity'));
    assert.doesNotThrow(() => assertCustodyQuantity(0.2, 'quantity', 0.3 - 0.1));
});
test('managers are scoped, only admin and director cross plants', () => {
    assert.throws(() => assertInternalPlantAccess(USER_ROLE.MANAGER, 'A', 'B'));
    assert.throws(() => assertInternalPlantAccess(USER_ROLE.MANAGER, undefined, 'A'));
    assert.doesNotThrow(() => assertInternalPlantAccess(USER_ROLE.MANAGER, 'A', 'A'));
    for (const role of [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR])
        assert.doesNotThrow(() => assertInternalPlantAccess(role, 'A', 'B'));
});
test('dates reject invalid chronology; today end-of-day is valid', () => {
    const now = new Date('2026-09-07T05:00:00Z');
    assert.throws(() => custodyDueDate('invalid', now));
    assert.throws(() => custodyDueDate('2026-09-06', now));
    assert.doesNotThrow(() => custodyDueDate('2026-09-07T16:59:59.999Z', now));
    assert.throws(() => assertCustodyOccurredAt(new Date('2026-09-06'), now, now));
    assert.throws(() => assertCustodyOccurredAt(new Date('2026-09-08'), now, now));
    assert.deepEqual(classifyMaterialRecallDue(new Date('2026-09-07T16:59:59.999Z'), now), {
        state: 'upcoming',
        days: 0,
    });
});
test('reference value is conserved and unknown legacy stock requires confirmation', () => {
    assert.deepEqual(takeReferenceValue(4, 100000, 1), { unitPrice: 25000, movedValue: 25000, remainingValue: 75000 });
    assert.throws(() => takeReferenceValue(4, undefined, 1));
    assert.deepEqual(takeReferenceValue(4, undefined, 1, 25000), {
        unitPrice: 25000,
        movedValue: 25000,
        remainingValue: 75000,
    });
    assert.equal(takeReferenceValue(3, 100, 3).remainingValue, 0);
    assert.equal(addReferenceValue(0, undefined, 25000), 25000);
    assert.equal(addReferenceValue(2, undefined, 25000), undefined);
    assert.throws(() => takeReferenceValue(0, 0, 1));
});
test('finalize accepts edited custody metadata and explicit clearing of return date', () => {
    const input = {
        requesterName: 'New holder',
        holderType: 'team',
        holderName: 'CM1',
        targetLine: 'CM1',
        expectedReturnAt: '',
        usageCampaignId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    };
    assert.deepEqual(finalizeInternalDraftSchema.parse(input), input);
});
