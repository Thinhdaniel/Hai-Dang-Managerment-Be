type Assignment = { lineId: unknown; quantity: number; startDate: string; dueDate: string };

export const validateLineAssignments = (
    assignments: Assignment[],
    total: number,
    start: string | undefined,
    due: string
) => {
    if (new Set(assignments.map((row) => String(row.lineId))).size !== assignments.length) {
        throw new Error('Mỗi tổ chỉ có một phần giao trong một đơn hàng');
    }
    if (assignments.reduce((sum, row) => sum + Number(row.quantity), 0) > total) {
        throw new Error('Tổng phân giao cho các tổ không được vượt số lượng đơn hàng');
    }
    for (const row of assignments) {
        if (!Number.isSafeInteger(row.quantity) || row.quantity <= 0)
            throw new Error('Số lượng phân giao phải là số nguyên dương');
        if (row.startDate > row.dueDate || row.dueDate > due || (start && row.startDate < start)) {
            throw new Error('Thời gian phân giao phải nằm trong thời gian thực hiện đơn hàng');
        }
    }
};
