export const MATERIAL_REUSE_TRACKING_MODE = {
    NONE: 'none',
    QUANTITY: 'quantity',
    SERIALIZED: 'serialized',
} as const;

export type MaterialReuseTrackingMode =
    (typeof MATERIAL_REUSE_TRACKING_MODE)[keyof typeof MATERIAL_REUSE_TRACKING_MODE];

export const MATERIAL_REUSE_TRACKING_MODE_VALUES = Object.values(MATERIAL_REUSE_TRACKING_MODE);

export const MATERIAL_CUSTODY_HOLDER_TYPE = {
    EMPLOYEE: 'employee',
    TEAM: 'team',
} as const;

export const MATERIAL_CUSTODY_SOURCE_TYPE = {
    NEW_STOCK: 'new_stock',
    OPENING_BALANCE: 'opening_balance',
    REUSABLE_POOL: 'reusable_pool',
    CUSTODY_TRANSFER: 'custody_transfer',
} as const;

export const MATERIAL_CUSTODY_ASSIGNMENT_STATUS = {
    ACTIVE: 'active',
    PARTIAL: 'partial',
    RECALL_DUE: 'recall_due',
    RESOLVED: 'resolved',
} as const;

export const MATERIAL_CUSTODY_CAMPAIGN_STATUS = {
    ACTIVE: 'active',
    RECALLING: 'recalling',
    CLOSED: 'closed',
} as const;

export const MATERIAL_CUSTODY_RESOLUTION = {
    USABLE: 'usable',
    REPAIR: 'repair',
    DAMAGED: 'damaged',
    LOST: 'lost',
} as const;

export const MATERIAL_CUSTODY_RESOLUTION_VALUES = Object.values(MATERIAL_CUSTODY_RESOLUTION);

export const MATERIAL_CUSTODY_MOVEMENT_TYPE = {
    ISSUE: 'issue',
    RETURN: 'return',
    LOSS: 'loss',
    TRANSFER_OUT: 'transfer_out',
    TRANSFER_IN: 'transfer_in',
    ADJUSTMENT: 'adjustment',
} as const;
