import assert from 'node:assert/strict';
import test from 'node:test';
import { buildItemLineReport } from '../production-item-line-report.helpers';
import { validateLineAssignments } from '../production-line-assignment.helpers';

const slots = [
    { key: 'a', label: '08h-09h', startMinute: 480, endMinute: 540 },
    { key: 'b', label: '09h-10h', startMinute: 540, endMinute: 600 },
];
const source = { itemId: 'i1', itemCode: '416', orderId: 'o1', orderCode: 'PO1', unit: 'SP' };
const line = (lineId = 'l1', quantity = 90, allocation = 'a1') => ({
    lineId,
    lineCode: lineId,
    runs: [{ ...source, id: 'r', planAllocationId: allocation }],
    entries: [{ slotKey: 'a', runId: 'r', quantity }],
    slotValues: [
        { key: 'a', runId: 'r', target: 100 },
        { key: 'b', runId: 'r', target: 100 },
    ],
});
const detail = (lines = [line()], date = '2026-09-21') => ({ productionDate: date, timeSlots: slots, lines });
const allocation = (lineId = 'l1', key = 'a1') => ({
    ...source,
    _id: key,
    lineId,
    lineCode: lineId,
    plannedQuantity: 200,
    startSlotKey: 'a',
    endSlotKey: 'b',
});
const plan = (allocations: any[] = [allocation()], date = '2026-09-21') => ({
    productionDate: date,
    timeSlots: slots,
    allocations,
});
const order = {
    _id: 'o1',
    code: 'PO1',
    itemId: 'i1',
    itemCode: '416',
    lineAssignments: [{ lineId: 'l1', lineCode: 'l1', quantity: 1000, startDate: '2026-09-01', dueDate: '2026-09-30' }],
};
const report = (changes: Record<string, any> = {}) =>
    buildItemLineReport({
        details: [detail()],
        cumulativeDetails: [detail()],
        prePeriodDetails: [],
        plans: [plan()],
        orders: [order],
        openingEntries: [],
        from: '2026-09-21',
        to: '2026-09-21',
        generatedAt: '2026-09-21T02:30:00Z',
        ...changes,
    });

test('separates two lines on one item and reconciles totals', () => {
    const d = detail([line('l1', 90, 'a1'), line('l2', 110, 'a2')]);
    const rows = report({
        details: [d],
        cumulativeDetails: [d],
        plans: [plan([allocation(), allocation('l2', 'a2')])],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.periodQuantity),
        [90, 110]
    );
    assert.deepEqual(
        rows.map((r) => r.deltaQuantity),
        [-10, 10]
    );
    assert.deepEqual(
        rows.map((r) => r.status),
        ['behind', 'ahead']
    );
    assert.equal(
        rows.reduce((n, r) => n + r.cumulativeQuantity, 0),
        200
    );
});
test('opening and earlier tracked output stay attributed to their line', () => {
    const earlier = detail([line('l1', 40)], '2026-09-20');
    const row = report({
        openingEntries: [{ ...source, lineId: 'l1', lineCode: 'l1', quantity: 100 }],
        prePeriodDetails: [earlier],
        cumulativeDetails: [earlier, detail()],
    })[0];
    assert.equal(row.openingQuantity, 140);
    assert.equal(row.cumulativeQuantity, 230);
    assert.equal(row.remainingQuantity, 770);
    assert.equal(row.completionPercent, 23);
});
test('does not credit an unassigned run to an order with the same item', () => {
    const l = line();
    delete (l.runs[0] as any).orderId;
    delete (l.runs[0] as any).orderCode;
    const d = detail([l]);
    const row = report({ details: [d], cumulativeDetails: [d] })[0];
    assert.equal(row.orders.length, 2);
    assert.equal(row.orders.find((r: any) => r.orderId === 'o1').cumulativeQuantity, 0);
    assert.equal(row.unassignedQuantity, 90);
    assert.equal(row.completionPercent, null);
    assert.equal(row.orders.find((r: any) => r.orderId === 'o1').status, 'missing_reports');
});
test('same item and line on different orders remain separate', () => {
    const l = line();
    l.runs.push({ ...source, orderId: 'o2', orderCode: 'PO2', id: 'r2', planAllocationId: 'a2' });
    l.entries.push({ slotKey: 'b', runId: 'r2', quantity: 80 });
    l.slotValues[1].runId = 'r2';
    const d = detail([l]);
    const row = report({
        details: [d],
        cumulativeDetails: [d],
        plans: [],
        orders: [order, { ...order, _id: 'o2', code: 'PO2' }],
    })[0];
    assert.equal(row.orders.length, 2);
    assert.deepEqual(
        row.orders.map((r: any) => r.cumulativeQuantity),
        [90, 80]
    );
});
test('future slots are not marked missing or included in progress', () => {
    const row = report()[0];
    assert.equal(row.plannedToDateQuantity, 100);
    assert.equal(row.missingReports, 0);
    const before = report({ generatedAt: '2026-09-21T00:00:00Z' })[0];
    assert.equal(before.deltaQuantity, null);
    assert.equal(before.status, 'not_due');
});
test('zero explicitly reported is not missing', () => {
    assert.equal(
        report({ details: [detail([line('l1', 0)])], cumulativeDetails: [detail([line('l1', 0)])] })[0].status,
        'behind'
    );
});
test('plan without production day is visible as missing, not omitted', () => {
    const row = report({ details: [], cumulativeDetails: [] })[0];
    assert.equal(row.missingReports, 1);
    assert.equal(row.status, 'missing_reports');
});
test('manual output remains in totals but is not invented as plan attainment', () => {
    const d = detail([line('l1', 90, '')]);
    const row = report({ details: [d], cumulativeDetails: [d] })[0];
    assert.equal(row.periodQuantity, 90);
    assert.equal(row.planActualQuantity, 0);
    assert.equal(row.status, 'needs_review');
});
test('carry over does not double original plan obligation', () => {
    const carry = {
        ...allocation('l1', 'a2'),
        plannedQuantity: 110,
        sourceType: 'carry_over',
        sourceAllocationId: 'a1',
    };
    const second = detail([line('l1', 110, 'a2')], '2026-09-22');
    const rows = report({
        details: [second],
        cumulativeDetails: [detail(), second],
        plans: [plan(), plan([carry], '2026-09-22')],
        from: '2026-09-22',
        to: '2026-09-22',
        generatedAt: '2026-09-22T06:00:00Z',
    });
    assert.equal(rows[0].plannedToDateQuantity, 200);
    assert.equal(rows[0].planActualQuantity, 200);
    assert.equal(rows[0].orders[0].days[0].carryQuantity, 110);
    assert.equal(rows[0].assignedQuantity, 1000);
});
test('broken carry-over lineage requires review', () => {
    const row = report({
        plans: [plan([{ ...allocation(), sourceType: 'carry_over', sourceAllocationId: 'missing' }])],
    })[0];
    assert.equal(row.status, 'needs_review');
});
test('historical assignment uses history before a later redistribution', () => {
    const old = order.lineAssignments;
    const row = report({
        orders: [
            {
                ...order,
                lineAssignments: [{ ...old[0], quantity: 500 }],
                history: [{ at: '2026-09-22T00:00:00Z', previousAssignments: old }],
            },
        ],
    })[0];
    assert.equal(row.assignedQuantity, 1000);
});
test('unallocated opening balance is not fabricated into item output', () => {
    const row = report({ openingEntries: [{ lineId: 'l1', quantity: 100, allocationState: 'unallocated' }] })[0];
    assert.equal(row.openingQuantity, 0);
});
test('no plan has no fake zero percent', () => {
    const d = detail([line()]);
    delete (d.lines[0].runs[0] as any).orderId;
    delete (d.lines[0].runs[0] as any).orderCode;
    const row = report({ details: [d], cumulativeDetails: [d], plans: [], orders: [] })[0];
    assert.equal(row.deltaQuantity, null);
    assert.equal(row.completionPercent, null);
    assert.equal(row.status, 'no_plan');
});
test('assignment validation rejects duplication, over-allocation and invalid dates', () => {
    const a = order.lineAssignments[0];
    assert.throws(() => validateLineAssignments([a, a], 3000, undefined, '2026-09-30'), /Mỗi tổ/);
    assert.throws(() => validateLineAssignments([a], 500, undefined, '2026-09-30'), /vượt/);
    assert.throws(() => validateLineAssignments([a], 1000, undefined, '2026-09-29'), /Thời gian/);
    assert.doesNotThrow(() => validateLineAssignments([a], 1000, undefined, '2026-09-30'));
});

test('a renamed line retains one cumulative total through stable identity', () => {
    const oldLine = line('l1', 40);
    oldLine.lineCode = 'CM5+6';
    const newLine = line('l1', 90);
    newLine.lineCode = 'CM5';
    const oldDay = detail([oldLine], '2026-09-20');
    const newDay = detail([newLine]);
    const rows = report({ details: [newDay], cumulativeDetails: [oldDay, newDay], prePeriodDetails: [oldDay] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].openingQuantity, 40);
    assert.equal(rows[0].periodQuantity, 90);
    assert.equal(rows[0].cumulativeQuantity, 130);
});

test('legacy runs with order code but no order id match only the same item', () => {
    const l = line();
    delete (l.runs[0] as any).orderId;
    l.runs[0].orderCode = ' po1 ';
    const d = detail([l]);
    const row = report({ details: [d], cumulativeDetails: [d] })[0];
    assert.equal(row.orders.length, 1);
    assert.equal(row.orders[0].orderId, 'o1');
    assert.equal(row.planActualQuantity, 90);
});

test('odd daily plan produces integer elapsed target and exact full-day total', () => {
    const plans = [plan([{ ...allocation(), plannedQuantity: 205 }])];
    assert.equal(report({ plans })[0].plannedToDateQuantity, 102);
    assert.equal(report({ plans, generatedAt: '2026-09-21T03:00:00Z' })[0].plannedToDateQuantity, 205);
});

test('different item output cannot satisfy a missing item plan on the same line', () => {
    const l = line();
    l.runs[0].itemId = 'i2';
    l.runs[0].itemCode = '028';
    delete (l.runs[0] as any).orderId;
    delete (l.runs[0] as any).orderCode;
    const d = detail([l]);
    const rows = report({ details: [d], cumulativeDetails: [d] });
    const planned = rows.find((row) => row.itemId === 'i1');
    assert.equal(planned.missingReports, 1);
    assert.equal(planned.cumulativeQuantity, 0);
    assert.equal(planned.status, 'missing_reports');
});

test('overproduction on one order cannot complete another order for the same team', () => {
    const a = { ...order.lineAssignments[0], quantity: 100 };
    const d = detail([line('l1', 200)]);
    const row = report({
        details: [d],
        cumulativeDetails: [d],
        plans: [],
        orders: [
            { ...order, lineAssignments: [a] },
            { ...order, _id: 'o2', code: 'PO2', lineAssignments: [a] },
        ],
    })[0];
    assert.equal(row.cumulativeQuantity, 200);
    assert.equal(row.assignedQuantity, 200);
    assert.equal(row.remainingQuantity, 100);
    assert.equal(row.completionPercent, 50);
});

test('carry-over reassigned to another team cannot silently inherit the original target', () => {
    const carry = { ...allocation('l2', 'a2'), sourceType: 'carry_over', sourceAllocationId: 'a1' };
    const rows = report({ plans: [plan(), plan([carry], '2026-09-22')], to: '2026-09-22' });
    assert.equal(rows.find((row) => row.lineId === 'l2').status, 'needs_review');
});
