const HANDOVER_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

type OutboundHandoverTimeline = {
    handoverTime: Date;
    expectedReturnTime?: Date | null;
    now?: Date;
};

export const getOutboundHandoverTimelineError = ({
    handoverTime,
    expectedReturnTime,
    now = new Date(),
}: OutboundHandoverTimeline): string | null => {
    const handoverTimestamp = handoverTime.getTime();
    if (!Number.isFinite(handoverTimestamp)) return 'Thoi gian ban giao khong hop le';

    if (handoverTimestamp > now.getTime() + HANDOVER_FUTURE_TOLERANCE_MS) {
        return 'Thoi gian ban giao khong duoc nam trong tuong lai';
    }

    if (expectedReturnTime) {
        const expectedReturnTimestamp = expectedReturnTime.getTime();
        if (!Number.isFinite(expectedReturnTimestamp)) return 'Han tra du kien khong hop le';
        if (expectedReturnTimestamp <= handoverTimestamp) {
            return 'Han tra du kien phai sau thoi gian ban giao';
        }
    }

    return null;
};
