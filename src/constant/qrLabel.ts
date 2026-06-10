export enum QR_LABEL_TYPE {
    MACHINE = 'machine',
}

export enum QR_LABEL_STATUS {
    UNUSED = 'unused',
    ASSIGNED = 'assigned',
    RETIRED = 'retired',
    LOST = 'lost',
    DAMAGED = 'damaged',
}

export enum QR_LABEL_BATCH_STATUS {
    DRAFT = 'draft',
    PRINTED = 'printed',
    PARTIALLY_ASSIGNED = 'partially_assigned',
    COMPLETED = 'completed',
}
