import { BadRequestError, UnAuthorizedError } from '@/errors/customError';
import { USER_ROLE } from '@/constant/allowedRoles';

export const assertCustodyQuantity = (quantity: number, mode: string, available?: number) => {
    if (!Number.isFinite(quantity) || quantity <= 0 || Number(quantity.toFixed(6)) !== quantity) {
        throw new BadRequestError('So luong phai lon hon 0 va toi da 6 chu so thap phan');
    }
    if (mode === 'serialized' && !Number.isInteger(quantity)) {
        throw new BadRequestError('Vat tu theo tung chiec phai nhap so nguyen');
    }
    if (available !== undefined && quantity > Number(available.toFixed(6))) {
        throw new BadRequestError(`So luong vuot so con lai (${available})`);
    }
};

export const assertInternalPlantAccess = (
    role: string | undefined,
    ownPlantId: string | undefined,
    plantId: string
) => {
    if (role === USER_ROLE.ADMIN || role === USER_ROLE.DIRECTOR) return;
    if (role !== USER_ROLE.MANAGER || !ownPlantId || ownPlantId !== plantId) {
        throw new UnAuthorizedError('Ban khong co quyen sua hoac chot phieu cua co so khac');
    }
};

export const custodyDueDate = (value: string | Date | undefined, issuedAt: Date, defaultDays = 0) => {
    const due = value
        ? new Date(value)
        : defaultDays
          ? new Date(issuedAt.getTime() + defaultDays * 86400000)
          : undefined;
    if (due && (!Number.isFinite(due.getTime()) || due < issuedAt)) {
        throw new BadRequestError('Han tra phai hop le va khong som hon ngay cap');
    }
    return due;
};

export const assertCustodyOccurredAt = (date: Date, issuedAt: Date, now = new Date()) => {
    if (!Number.isFinite(date.getTime()) || date < issuedAt || date > now) {
        throw new BadRequestError('Ngay xu ly phai tu ngay cap den thoi diem hien tai');
    }
};

// Reference values describe custody responsibility, never an additional expense.
export const takeReferenceValue = (
    stock: number,
    value: number | undefined,
    quantity: number,
    confirmedPrice?: number
) => {
    if (!Number.isFinite(stock) || stock <= 0 || (value !== undefined && (!Number.isFinite(value) || value < 0))) {
        throw new BadRequestError('Ton hoac gia tri tham chieu khong hop le');
    }
    assertCustodyQuantity(quantity, 'quantity', stock);
    if (
        value === undefined &&
        (confirmedPrice === undefined || !Number.isFinite(confirmedPrice) || confirmedPrice < 0)
    ) {
        throw new BadRequestError('Ton cu chua co gia tri tham chieu. Vui long xac nhan don gia truoc khi xu ly');
    }
    const total = value ?? stock * confirmedPrice!;
    const unitPrice = total / stock;
    const movedValue = quantity === Number(stock.toFixed(6)) ? total : quantity * unitPrice;
    return { unitPrice, movedValue, remainingValue: Math.max(0, total - movedValue) };
};

export const addReferenceValue = (stock: number, value: number | undefined, incomingValue: number) =>
    stock === 0 ? incomingValue : value === undefined ? undefined : value + incomingValue;
