export enum ASSET_STATUS {
    ACTIVE = 'active',
    MAINTENANCE = 'maintenance',
    BROKEN = 'broken',
    BORROWING = 'borrowing',
    STORAGE = 'storage',
    PENDING_DISPOSAL = 'pending_disposal',
    DISPOSED = 'disposed',
    RETURNED_TO_PARTNER = 'returned_to_partner',
}

export enum ASSET_OWNERSHIP_TYPE {
    OWNED = 'owned',
    PARTNER_BORROWED = 'partner_borrowed',
    RENTAL = 'rental',
}
