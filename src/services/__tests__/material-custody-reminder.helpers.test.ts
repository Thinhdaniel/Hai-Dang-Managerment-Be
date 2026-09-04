import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildMaterialCustodyReminderCopy,
    classifyMaterialRecallDue,
    getMaterialCustodyReminderDateKey,
} from '@/services/material-custody-reminder.helpers';

test('classifyMaterialRecallDue distinguishes upcoming and overdue deadlines', () => {
    const now = new Date('2026-09-04T00:00:00.000Z');
    assert.deepEqual(classifyMaterialRecallDue(new Date('2026-09-05T00:00:00.000Z'), now), {
        state: 'upcoming',
        days: 1,
    });
    assert.deepEqual(classifyMaterialRecallDue(new Date('2026-09-02T12:00:00.000Z'), now), {
        state: 'overdue',
        days: 2,
    });
});

test('buildMaterialCustodyReminderCopy includes business identifiers and outstanding scope', () => {
    const result = buildMaterialCustodyReminderCopy({
        campaignCode: 'DTSD-2026-001',
        itemCode: 'MH-028',
        dueAt: new Date('2026-09-03T16:59:59.000Z'),
        outstandingQuantity: 12,
        holderCount: 3,
        now: new Date('2026-09-04T00:00:00.000Z'),
    });
    assert.equal(result.type, 'error');
    assert.match(result.title, /MH-028/);
    assert.match(result.message, /DTSD-2026-001/);
    assert.match(result.message, /12/);
    assert.match(result.message, /3 người\/tổ/);
});

test('date key follows Vietnam calendar day', () => {
    assert.equal(getMaterialCustodyReminderDateKey(new Date('2026-09-03T18:00:00.000Z')), '2026-09-04');
});
