export enum BORROWING_DIRECTION {
    INTERNAL = 'internal',
    INBOUND = 'inbound',
    OUTBOUND = 'outbound',
}

export enum BORROWING_ITEM_STATUS {
    DRAFT = 'draft',
    ACTIVE = 'active',
    RETURNED = 'returned',
    CANCELLED = 'cancelled',
}

export enum BORROWING_BATCH_STATUS {
    DRAFT = 'draft',
    RECEIVING = 'receiving',
    PENDING_APPROVAL = 'pending_approval',
    APPROVED = 'approved',
    ACTIVE = 'active',
    PARTIALLY_RETURNED = 'partially_returned',
    RETURNED = 'returned',
    REJECTED = 'rejected',
    CANCELLED = 'cancelled',
}

export const resolveBorrowingDirection = (direction?: string | null, type?: string | null) => {
    if (direction === BORROWING_DIRECTION.INTERNAL || type === 'internal') return BORROWING_DIRECTION.INTERNAL;
    if (direction === BORROWING_DIRECTION.OUTBOUND) return BORROWING_DIRECTION.OUTBOUND;
    return BORROWING_DIRECTION.INBOUND;
};

export const isOutboundBorrowing = (direction?: string | null, type?: string | null) =>
    resolveBorrowingDirection(direction, type) === BORROWING_DIRECTION.OUTBOUND;
