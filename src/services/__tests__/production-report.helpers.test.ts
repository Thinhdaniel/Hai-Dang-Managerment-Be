import { buildProductionReport } from '@/services/production-report.helpers';
import assert from 'node:assert/strict';
import test from 'node:test';

const makeDetail = ({
    date,
    status = 'locked',
    quantities = [90],
    secondReported = false,
}: {
    date: string;
    status?: string;
    quantities?: number[];
    secondReported?: boolean;
}) => {
    const actual = quantities.reduce((sum, value) => sum + value, 0);
    const entries = quantities.map((quantity, index) => ({
        id: `entry-${date}-${index}`,
        slotKey: index === 0 ? '08:00' : '09:00',
        runId: 'run-1',
        quantity,
        note: quantity === 0 ? '' : undefined,
        amount: quantity * 10,
    }));
    return {
        id: `day-${date}`,
        productionDate: date,
        status,
        timeSlots: [
            { key: '08:00', label: '08:00 - 09:00' },
            { key: '09:00', label: '09:00 - 10:00' },
        ],
        summary: {
            lineCount: 1,
            configuredLineCount: 1,
            totalWorkers: 10,
            totalTarget: 200,
            totalActual: actual,
            achievementPercent: (actual / 200) * 100,
            totalAmount: actual * 10,
        },
        lines: [
            {
                lineId: 'line-1',
                lineCode: 'C1',
                lineName: 'Chuyền 1',
                leaderName: 'Tổ trưởng A',
                workerCount: 10,
                configured: true,
                totalTarget: 200,
                totalActual: actual,
                achievementPercent: (actual / 200) * 100,
                totalAmount: actual * 10,
                runs: [
                    {
                        id: 'run-1',
                        itemId: 'item-1',
                        itemCode: 'HD-01',
                        itemName: 'Áo mẫu',
                        unit: 'SP',
                        planAllocationId: 'allocation-1',
                    },
                ],
                entries,
                slotValues: [
                    { key: '08:00', target: 100, actual: quantities[0] || 0, reported: true, runId: 'run-1' },
                    {
                        key: '09:00',
                        target: 100,
                        actual: quantities[1] || 0,
                        reported: secondReported,
                        runId: 'run-1',
                    },
                ],
            },
        ],
    };
};

const makePlan = (date: string, quantity = 200) => ({
    productionDate: date,
    allocations: [
        {
            _id: 'allocation-1',
            lineId: 'line-1',
            lineCode: 'C1',
            itemId: 'item-1',
            itemCode: 'HD-01',
            itemName: 'Áo mẫu',
            unit: 'SP',
            plannedQuantity: quantity,
        },
    ],
});

const options = {
    plantId: 'plant-1',
    plantName: 'Cơ sở 1',
    from: '2026-07-20',
    to: '2026-07-20',
    scope: 'all' as const,
    financialsVisible: true,
};

test('tổng hợp nhất quán sản lượng, kế hoạch, báo đủ và năng suất', () => {
    const report = buildProductionReport([makeDetail({ date: '2026-07-20' })], [makePlan('2026-07-20')], options);

    assert.equal(report.summary.actualQuantity, 90);
    assert.equal(report.summary.targetQuantity, 200);
    assert.equal(report.summary.achievementPercent, 45);
    assert.equal(report.summary.plannedQuantity, 200);
    assert.equal(report.summary.planAttainmentPercent, 45);
    assert.equal(report.summary.reportingRate, 50);
    assert.equal(report.summary.outputPerWorkerDay, 9);
    assert.equal(report.summary.totalAmount, 900);
    assert.equal(report.lines[0].actualQuantity, 90);
    assert.equal(report.items[0].targetQuantity, 200);
});

test('phân loại ngoại lệ và không coi ngày khóa sổ là ngày mở', () => {
    const report = buildProductionReport([makeDetail({ date: '2026-07-20' })], [makePlan('2026-07-20')], options);

    assert.equal(report.exceptionSummary.missingReports, 1);
    assert.equal(report.exceptionSummary.underTarget, 1);
    assert.equal(report.exceptionSummary.openDays, 0);
    assert.equal(report.exceptionSummary.critical, 2);
});

test('ẩn toàn bộ giá trị tài chính và tính so sánh kỳ trước', () => {
    const current = makeDetail({ date: '2026-07-20', quantities: [120, 80], secondReported: true });
    const previous = makeDetail({ date: '2026-07-19', quantities: [80, 20], secondReported: true });
    const report = buildProductionReport([current], [makePlan('2026-07-20')], {
        ...options,
        financialsVisible: false,
        previousFrom: '2026-07-19',
        previousTo: '2026-07-19',
        previousDetails: [previous],
        previousPlans: [makePlan('2026-07-19')],
    });

    assert.equal(report.comparison.available, true);
    assert.equal(report.comparison.delta?.actualPercent, 100);
    assert.equal(report.comparison.delta?.achievementPoints, 50);
    assert.equal(Object.hasOwn(report.summary, 'totalAmount'), false);
    assert.equal(Object.hasOwn(report.lines[0], 'totalAmount'), false);
    assert.equal(Object.hasOwn(report.items[0], 'totalAmount'), false);
});
