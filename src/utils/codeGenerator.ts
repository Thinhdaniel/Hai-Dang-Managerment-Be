import type { ClientSession, Model } from 'mongoose';

/**
 * Generates a document code in format: PREFIX-YYYYMMDD-XXX
 * Sequence resets every day and is zero-padded to 3 digits.
 *
 * Examples:
 *   YC-20260115-001  (đề xuất cấp vật tư)
 *   DX-20260115-001  (đề xuất mua)
 *   CP-20260115-001  (phiếu cấp phát)
 *   PO-20260115-001  (đơn đặt hàng NCC)
 *   NK-20260115-001  (phiếu nhập kho)
 */
export const generateCode = async ({
    model,
    field,
    prefix,
    session,
}: {
    model: Model<any>;
    field: string;
    prefix: string;
    session?: ClientSession;
}): Promise<string> => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    const dayPrefix = `${prefix}-${dateStr}-`;

    const query = model
        .findOne({
            [field]: new RegExp(`^${dayPrefix}`),
            isDeleted: { $ne: true },
        })
        .sort({ [field]: -1 })
        .select(field)
        .lean();

    if (session) {
        (query as any).session(session);
    }

    const latest = (await query) as Record<string, unknown> | null;
    const latestCode = typeof latest?.[field] === 'string' ? String(latest[field]) : '';
    const latestSequence = Number(latestCode.split('-').pop()) || 0;

    return `${dayPrefix}${String(latestSequence + 1).padStart(3, '0')}`;
};
