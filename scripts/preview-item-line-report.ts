import fs from 'node:fs';
import { buildItemLineReport } from '../src/services/production-item-line-report.helpers';

const slots = [
    { key: '08', label: '08h-09h', startMinute: 480, endMinute: 540 },
    { key: '09', label: '09h-10h', startMinute: 540, endMinute: 600 },
];
const date = '2026-09-22';
const shared = {
    itemId: 'item416',
    itemCode: '416',
    itemName: 'Quần short xuất khẩu',
    unit: 'SP',
    orderId: 'order1',
    orderCode: 'PO-416-09',
};
const lines = [
    { id: 'l1', code: 'CM2+3', quantity: 900, opening: 800, planned: 1000, assigned: 3000 },
    { id: 'l2', code: 'CM4', quantity: 1000, opening: 200, planned: 900, assigned: 2000 },
];
const details = [
    {
        productionDate: date,
        timeSlots: slots,
        lines: lines.map((line) => ({
            lineId: line.id,
            lineCode: line.code,
            runs: [{ ...shared, id: line.id + '-run', planAllocationId: line.id + '-allocation' }],
            entries: slots.map((slot) => ({
                slotKey: slot.key,
                runId: line.id + '-run',
                quantity: line.quantity / 2,
                note: 'Sản lượng đã kiểm tra',
            })),
            slotValues: slots.map((slot) => ({ key: slot.key, runId: line.id + '-run', target: line.planned / 2 })),
        })),
    },
];
const rows = buildItemLineReport({
    details,
    cumulativeDetails: details,
    prePeriodDetails: [],
    plans: [
        {
            productionDate: date,
            timeSlots: slots,
            allocations: lines.map((line) => ({
                ...shared,
                _id: line.id + '-allocation',
                lineId: line.id,
                lineCode: line.code,
                plannedQuantity: line.planned,
                startSlotKey: '08',
                endSlotKey: '09',
            })),
        },
    ],
    orders: [
        {
            ...shared,
            _id: 'order1',
            code: shared.orderCode,
            lineAssignments: lines.map((line) => ({
                lineId: line.id,
                lineCode: line.code,
                quantity: line.assigned,
                startDate: '2026-09-01',
                dueDate: '2026-09-30',
            })),
        },
    ],
    openingEntries: lines.map((line) => ({ ...shared, lineId: line.id, lineCode: line.code, quantity: line.opening })),
    from: date,
    to: date,
    generatedAt: '2026-09-22T04:00:00Z',
});
const target = new URL('../../Hai-Dang-Managerment-Fe/.tmp/item-line-fixture.json', import.meta.url);
fs.mkdirSync(new URL('.', target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(rows, null, 2));
console.log('Generated preview from actual backend report helper');
