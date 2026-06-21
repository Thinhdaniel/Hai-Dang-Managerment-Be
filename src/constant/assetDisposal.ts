export enum ASSET_DISPOSAL_BATCH_STATUS {
    DRAFT = 'draft',
    SCANNING = 'scanning',
    REVIEWING = 'reviewing',
    APPROVED = 'approved',
    COMPLETED = 'completed',
    CANCELLED = 'cancelled',
}

export enum ASSET_DISPOSAL_ITEM_STATUS {
    PENDING = 'pending',
    CHECKED = 'checked',
    APPROVED = 'approved',
    DISPOSED = 'disposed',
    KEPT = 'kept',
    CANCELLED = 'cancelled',
}

export enum ASSET_DISPOSAL_SOURCE_TYPE {
    ASSET = 'asset',
    EXTERNAL = 'external',
    QR_ONLY = 'qr_only',
}

export enum ASSET_DISPOSAL_CONDITION {
    USABLE = 'usable',
    MINOR_FAULT = 'minor_fault',
    MAJOR_FAULT = 'major_fault',
    MISSING_PARTS = 'missing_parts',
    SCRAP = 'scrap',
    UNKNOWN = 'unknown',
}

export enum ASSET_DISPOSAL_ACTION {
    SELL = 'sell',
    PART_OUT = 'part_out',
    SCRAP = 'scrap',
    KEEP = 'keep',
    REPAIR = 'repair',
    UNKNOWN = 'unknown',
}
