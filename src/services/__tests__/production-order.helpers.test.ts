import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isRecognizedProductionOrderPriority,
    isRecognizedProductionOrderStatus,
    normalizeProductionOrderCode,
    parseProductionOrderDate,
    parseProductionOrderPriority,
    parseProductionOrderStatus,
    productionOrderDeadlineStatus,
    summarizeProductionOrderProgress,
} from '../production-order.helpers';

test('chuẩn hóa mã đơn nhưng không phá dấu phân cách nghiệp vụ', () => {
    assert.equal(normalizeProductionOrderCode(' po-2026  001 '), 'PO-2026 001');
});

test('đọc ngày Excel theo cả định dạng Việt Nam và ISO', () => {
    assert.equal(parseProductionOrderDate('12/09/2026'), '2026-09-12');
    assert.equal(parseProductionOrderDate('2026-09-20'), '2026-09-20');
    assert.equal(parseProductionOrderDate('31/02/2026'), undefined);
});

test('đọc ưu tiên và trạng thái tiếng Việt', () => {
    assert.equal(parseProductionOrderPriority('Khẩn'), 'urgent');
    assert.equal(parseProductionOrderStatus('Đang sản xuất'), 'in_production');
});

test('phát hiện giá trị Excel không thuộc danh mục thay vì âm thầm đổi thành nháp', () => {
    assert.equal(isRecognizedProductionOrderPriority('Bình thường'), true);
    assert.equal(isRecognizedProductionOrderPriority('siêu gấp tùy ý'), false);
    assert.equal(isRecognizedProductionOrderStatus('Sẵn sàng'), true);
    assert.equal(isRecognizedProductionOrderStatus('đang chờ vải'), false);
});

test('tổng hợp đầu kỳ và sản lượng hệ thống không bị âm phần còn lại', () => {
    assert.deepEqual(
        summarizeProductionOrderProgress({
            totalQuantity: 1000,
            openingQuantity: 400,
            trackedQuantity: 650,
            futurePlannedQuantity: 100,
        }),
        {
            openingQuantity: 400,
            trackedQuantity: 650,
            producedQuantity: 1050,
            remainingQuantity: 0,
            excessQuantity: 50,
            completionPercent: 105,
            futurePlannedQuantity: 100,
            unplannedQuantity: 0,
        }
    );
});

test('phân loại hạn giao theo ngày nghiệp vụ', () => {
    assert.equal(
        productionOrderDeadlineStatus({ dueDate: '2026-09-11', remainingQuantity: 10, today: '2026-09-12' }).code,
        'overdue'
    );
    assert.equal(
        productionOrderDeadlineStatus({ dueDate: '2026-09-14', remainingQuantity: 10, today: '2026-09-12' }).code,
        'due_soon'
    );
});
