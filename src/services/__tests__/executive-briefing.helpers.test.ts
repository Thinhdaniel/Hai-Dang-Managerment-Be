import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDeterministicBriefingContent,
    compareValues,
    containsNumericClaim,
    getClosedBriefingPeriod,
} from '@/services/executive-briefing.helpers';
import type { ExecutiveBriefingSnapshot } from '@/types/executiveBriefing';

const snapshot: ExecutiveBriefingSnapshot = {
    fleet: {
        registeredOwned: 100,
        operationalMachines: 90,
        activeMachines: 81,
        maintenanceMachines: 5,
        brokenMachines: 2,
        storageMachines: 2,
        pendingDisposalMachines: 0,
        disposedMachines: 10,
        unassignedMachines: 1,
        linkedQrAssets: 80,
        availabilityPct: 90,
        qrCoveragePct: 88.9,
    },
    maintenance: {
        newTickets: compareValues(8, 10),
        completedTickets: compareValues(9, 7),
        emergencyTickets: compareValues(2, 1),
        externalRepairCost: compareValues(30_000_000, 40_000_000),
        openTickets: 6,
        overdueTickets: 2,
        avgResolutionDays: 2.5,
        repeatFailureAssets: 1,
        completedWithEvidence: 8,
        evidenceCoveragePct: 88.9,
        topRepeatAssets: [],
        notableIncidents: [],
    },
    materials: {
        purchaseValue: compareValues(100_000_000, 80_000_000),
        distributionValue: compareValues(50_000_000, 60_000_000),
        pendingPurchaseRequests: 3,
        approvedAwaitingOrder: 2,
        partialPurchaseOrders: 1,
        openPurchaseShortages: 1,
        openPurchaseShortageQuantity: 4,
        openSupplyShortages: 0,
        openSupplyShortageQuantity: 0,
        lowStockCount: 3,
        lowStockItems: [],
    },
    operations: {
        transfersCreated: compareValues(4, 3),
        transfersCompleted: compareValues(3, 2),
        transferredAssets: 7,
        openTransfers: 1,
        mislocatedAssets: 1,
        mislocatedItems: [],
        stocktakeSessions: compareValues(2, 1),
        stocktakeMissing: 1,
        stocktakeAnomalies: 1,
    },
    plants: [],
    evidence: [],
    dataDefinitions: [],
    dataWarnings: [],
};

test('tính đúng tuần đã đóng theo múi giờ Việt Nam', () => {
    const period = getClosedBriefingPeriod('week', new Date('2026-07-14T03:00:00.000Z'));
    assert.equal(period.periodKey, '2026-W28');
    assert.equal(period.rangeStart.toISOString(), '2026-07-05T17:00:00.000Z');
    assert.equal(period.rangeEnd.toISOString(), '2026-07-12T16:59:59.999Z');
    assert.equal(period.comparisonKey, '2026-W27');
});

test('tính đúng tháng đã đóng theo múi giờ Việt Nam', () => {
    const period = getClosedBriefingPeriod('month', new Date('2026-07-14T03:00:00.000Z'));
    assert.equal(period.periodKey, '2026-06');
    assert.equal(period.rangeStart.toISOString(), '2026-05-31T17:00:00.000Z');
    assert.equal(period.rangeEnd.toISOString(), '2026-06-30T16:59:59.999Z');
    assert.equal(period.comparisonKey, '2026-05');
});

test('không tạo phần trăm tăng vô hạn khi kỳ trước bằng không', () => {
    assert.deepEqual(compareValues(10, 0), { current: 10, previous: 0, delta: 10, deltaPct: null });
    assert.deepEqual(compareValues(0, 0), { current: 0, previous: 0, delta: 0, deltaPct: 0 });
});

test('nhận diện chữ số để chặn khẳng định số liệu do AI tự viết', () => {
    assert.equal(containsNumericClaim('Có 12 phiếu cần xử lý'), true);
    assert.equal(containsNumericClaim('Có phiếu cần xử lý'), false);
});

test('nội dung dự phòng tách riêng mua, cấp phát và tạo hành động từ rủi ro thật', () => {
    const result = buildDeterministicBriefingContent(snapshot, 'Tuần kiểm thử');
    assert.match(result.summary, /100\.000\.000 đ/);
    assert.match(result.summary, /50\.000\.000 đ/);
    assert.match(result.summary, /hai chỉ số được trình bày riêng/);
    assert.ok(result.risks.some((row) => row.actionKey === 'maintenance_overdue'));
    assert.ok(result.risks.some((row) => row.actionKey === 'inventory_low_stock'));
    assert.ok(result.actions.every((row) => Boolean(row.actionUrl)));
});
