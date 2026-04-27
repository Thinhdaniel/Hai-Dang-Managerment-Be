export enum ORDER_STATUS {
    PENDING = 'pending',
    CANCELLED = 'cancelled',
    CONFIRMED = 'confirmed',
    SHIPPING = 'shipping',
    DELIVERED = 'delivered',
    DONE = 'done',
}

export enum ORDER_PAYMENT_STATUS {
    PENDING = 'pending',
    CANCELLED = 'cancelled',
    SUCCESSED = 'successed',
    CONFIRMED = 'confirmed',
}

export enum PAYMENT_METHOD {
    CASH = 'cash',
    CARD = 'card',
}

export enum SHIPPING_METHOD {
    STANDARD = 'standard',
    SPECIAL = 'special',
}
