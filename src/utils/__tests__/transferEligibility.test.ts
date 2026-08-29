import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSET_STATUS } from '@/constant/assetStatus';
import { BORROWING_DIRECTION, BORROWING_ITEM_STATUS } from '@/constant/borrowing';
import { isAssetStatusBlockedForTransfer, isOutboundBorrowingBlockingTransfer } from '@/utils/transferEligibility';

test('chặn điều chuyển máy đang cho đối tác mượn và máy đã đóng vòng đời', () => {
    assert.equal(isAssetStatusBlockedForTransfer(ASSET_STATUS.LOANED_OUT), true);
    assert.equal(isAssetStatusBlockedForTransfer(ASSET_STATUS.RETURNED_TO_PARTNER), true);
    assert.equal(isAssetStatusBlockedForTransfer(ASSET_STATUS.PENDING_DISPOSAL), true);
    assert.equal(isAssetStatusBlockedForTransfer(ASSET_STATUS.DISPOSED), true);
    assert.equal(isAssetStatusBlockedForTransfer(ASSET_STATUS.ACTIVE), false);
    assert.equal(isAssetStatusBlockedForTransfer(ASSET_STATUS.STORAGE), false);
});

test('chặn điều chuyển từ lúc máy được giữ trong lô cho mượn đến khi nhận lại', () => {
    assert.equal(isOutboundBorrowingBlockingTransfer(BORROWING_DIRECTION.OUTBOUND, BORROWING_ITEM_STATUS.DRAFT), true);
    assert.equal(isOutboundBorrowingBlockingTransfer(BORROWING_DIRECTION.OUTBOUND, BORROWING_ITEM_STATUS.ACTIVE), true);
    assert.equal(
        isOutboundBorrowingBlockingTransfer(BORROWING_DIRECTION.OUTBOUND, BORROWING_ITEM_STATUS.RETURNED),
        false
    );
    assert.equal(isOutboundBorrowingBlockingTransfer(BORROWING_DIRECTION.INBOUND, BORROWING_ITEM_STATUS.ACTIVE), false);
});
