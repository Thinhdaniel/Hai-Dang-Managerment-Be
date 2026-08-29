import { ASSET_STATUS } from '@/constant/assetStatus';
import { BORROWING_DIRECTION, BORROWING_ITEM_STATUS } from '@/constant/borrowing';

const TRANSFER_BLOCKED_ASSET_STATUSES = new Set<string>([
    ASSET_STATUS.LOANED_OUT,
    ASSET_STATUS.RETURNED_TO_PARTNER,
    ASSET_STATUS.PENDING_DISPOSAL,
    ASSET_STATUS.DISPOSED,
]);

export const isAssetStatusBlockedForTransfer = (status?: string | null) =>
    Boolean(status && TRANSFER_BLOCKED_ASSET_STATUSES.has(status));

export const isOutboundBorrowingBlockingTransfer = (direction?: string | null, status?: string | null) =>
    direction === BORROWING_DIRECTION.OUTBOUND &&
    (status === BORROWING_ITEM_STATUS.DRAFT || status === BORROWING_ITEM_STATUS.ACTIVE);
