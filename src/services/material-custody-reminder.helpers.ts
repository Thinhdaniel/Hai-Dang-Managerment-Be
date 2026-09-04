const DAY_MS = 24 * 60 * 60 * 1000;

export const getMaterialCustodyReminderDateKey = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);

export const classifyMaterialRecallDue = (dueAt: Date, now: Date) => {
    const remainingMs = dueAt.getTime() - now.getTime();
    if (remainingMs < 0) {
        return { state: 'overdue' as const, days: Math.max(1, Math.ceil(Math.abs(remainingMs) / DAY_MS)) };
    }
    return { state: 'upcoming' as const, days: Math.max(0, Math.ceil(remainingMs / DAY_MS)) };
};

export const buildMaterialCustodyReminderCopy = ({
    campaignCode,
    itemCode,
    dueAt,
    outstandingQuantity,
    holderCount,
    now,
}: {
    campaignCode: string;
    itemCode: string;
    dueAt: Date;
    outstandingQuantity: number;
    holderCount: number;
    now: Date;
}) => {
    const due = classifyMaterialRecallDue(dueAt, now);
    const dueLabel = dueAt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    if (due.state === 'overdue') {
        return {
            type: 'error' as const,
            title: `CCDC mã hàng ${itemCode} đã quá hạn thu hồi`,
            message: `${campaignCode} còn ${outstandingQuantity.toLocaleString('vi-VN')} đơn vị tại ${holderCount} người/tổ; quá hạn ${due.days} ngày (hạn ${dueLabel}).`,
        };
    }
    return {
        type: 'warning' as const,
        title:
            due.days === 0
                ? `CCDC mã hàng ${itemCode} đến hạn hôm nay`
                : `Sắp đến hạn thu hồi CCDC mã hàng ${itemCode}`,
        message: `${campaignCode} còn ${outstandingQuantity.toLocaleString('vi-VN')} đơn vị tại ${holderCount} người/tổ; hạn ${dueLabel}.`,
    };
};
