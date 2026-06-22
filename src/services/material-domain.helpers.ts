import { BadRequestError, NotFoundError } from '@/errors/customError';
import Material from '@/models/Material';
import Supplier from '@/models/Supplier';
import type { ClientSession } from 'mongoose';
import { computeLineTotal, toId } from './material-workflow.helpers';

type MaterialMap = Map<string, any>;
type SupplierMap = Map<string, any>;

const ensureAllReferencesFound = (expectedIds: string[], lookupMap: Map<string, any>, errorMessage: string) => {
    const missingIds = expectedIds.filter((id) => !lookupMap.has(id));

    if (missingIds.length) {
        throw new NotFoundError(errorMessage);
    }
};

export const getMaterialsMap = async (materialIds: string[], session?: ClientSession) => {
    const uniqueMaterialIds = Array.from(new Set(materialIds.filter(Boolean)));

    if (!uniqueMaterialIds.length) {
        return new Map() as MaterialMap;
    }

    const query = Material.find({
        _id: { $in: uniqueMaterialIds },
        isDeleted: { $ne: true },
        isActive: { $ne: false },
    });

    if (session) {
        query.session(session);
    }

    const materials = await query;
    const materialsMap = new Map(materials.map((material) => [String(material._id), material]));

    ensureAllReferencesFound(uniqueMaterialIds, materialsMap, 'Khong tim thay vat tu');

    return materialsMap;
};

export const getSuppliersMap = async (supplierIds: string[], session?: ClientSession) => {
    const uniqueSupplierIds = Array.from(new Set(supplierIds.filter(Boolean)));

    if (!uniqueSupplierIds.length) {
        return new Map() as SupplierMap;
    }

    const query = Supplier.find({
        _id: { $in: uniqueSupplierIds },
        isDeleted: { $ne: true },
        isActive: { $ne: false },
    });

    if (session) {
        query.session(session);
    }

    const suppliers = await query;
    const suppliersMap = new Map(suppliers.map((supplier) => [String(supplier._id), supplier]));

    ensureAllReferencesFound(uniqueSupplierIds, suppliersMap, 'Khong tim thay nha cung cap');

    return suppliersMap;
};

export const buildPurchaseRequestItems = ({
    items,
    materialsMap,
    suppliersMap,
}: {
    items: any[];
    materialsMap: MaterialMap;
    suppliersMap: SupplierMap;
}) => {
    const normalizedItems = items.map((item) => {
        const material = materialsMap.get(String(item.materialId));
        const supplierId = item.supplierId ? String(item.supplierId) : undefined;
        const supplier = supplierId ? suppliersMap.get(supplierId) : undefined;
        const quantityRequested = Number(item.quantityRequested ?? 0);
        const quantityApproved = item.quantityApproved != null ? Number(item.quantityApproved) : undefined;
        const estimatedPrice = item.estimatedPrice != null ? Number(item.estimatedPrice) : undefined;
        const effectiveQuantity = quantityApproved != null ? quantityApproved : quantityRequested;

        return {
            materialId: material._id,
            materialName: material.name,
            unit: material.unit,
            quantityRequested,
            quantityApproved,
            estimatedPrice,
            estimatedTotal: computeLineTotal(effectiveQuantity, estimatedPrice),
            supplierId: supplier?._id,
            supplierName: supplier?.name,
            note: item.note?.trim() || undefined,
        };
    });

    const totalEstimated = normalizedItems.reduce((sum, item) => sum + (item.estimatedTotal ?? 0), 0);

    return {
        items: normalizedItems,
        totalEstimated: Number(totalEstimated.toFixed(2)),
    };
};

export const buildPurchaseOrderItems = ({ items, materialsMap }: { items: any[]; materialsMap: MaterialMap }) => {
    const normalizedItems = items.map((item) => {
        const material = materialsMap.get(String(item.materialId));
        const quantity = Number(item.quantity ?? 0);
        const unitPrice = Number(item.unitPrice ?? 0);

        return {
            materialId: material._id,
            materialName: material.name,
            unit: item.unit?.trim() || material.unit,
            quantityRequested: quantity,
            quantityOrdered: quantity,
            quantityReceived: 0,
            quantityMissing: quantity,
            receiveStatus: 'pending',
            unitPrice,
            totalPrice: computeLineTotal(quantity, unitPrice),
            vatRate: 0,
            vatAmount: 0,
            totalWithVat: computeLineTotal(quantity, unitPrice),
            catalogStatus: 'matched',
            quantityInventoried: 0,
            inventoryStatus: 'pending',
            note: item.note?.trim() || undefined,
        };
    });

    const totalAmount = normalizedItems.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);

    return {
        items: normalizedItems,
        totalAmount: Number(totalAmount.toFixed(2)),
        totalVat: 0,
        totalWithVat: Number(totalAmount.toFixed(2)),
    };
};

export const buildDistributionItems = ({ items, materialsMap }: { items: any[]; materialsMap: MaterialMap }) => {
    return items.map((item) => {
        const material = materialsMap.get(String(item.materialId));

        return {
            materialId: material._id,
            materialName: material.name,
            unit: item.unit?.trim() || material.unit,
            quantity: Number(item.quantity ?? 0),
            note: item.note?.trim() || undefined,
        };
    });
};

export const calculateActualTotalForRequest = (request: any, orderItems: any[]) => {
    const orderItemMap = new Map(orderItems.map((item) => [toId(item.materialId), item]));

    const totalActual = (request.items ?? []).reduce((sum: number, item: any) => {
        const orderItem = orderItemMap.get(toId(item.materialId));
        if (!orderItem) {
            return sum;
        }

        const quantity = Number(item.quantityApproved ?? item.quantityRequested ?? 0);
        const lineTotal = computeLineTotal(quantity, Number(orderItem.unitPrice ?? 0));
        return sum + lineTotal;
    }, 0);

    return Number(totalActual.toFixed(2));
};

export const ensureSingleSupplierForItems = (requests: any[], supplierId?: string) => {
    const foundSupplierIds = new Set<string>();

    requests.forEach((request) => {
        (request.items ?? []).forEach((item: any) => {
            const currentSupplierId = toId(item.supplierId);
            if (currentSupplierId) {
                foundSupplierIds.add(currentSupplierId);
            }
        });
    });

    if (supplierId) {
        const hasConflictingSupplier = Array.from(foundSupplierIds).some((itemId) => itemId !== supplierId);
        if (hasConflictingSupplier) {
            throw new BadRequestError('Cac phieu de xuat dang chua vat tu cua nha cung cap khac');
        }

        return supplierId;
    }

    if (foundSupplierIds.size > 1) {
        throw new BadRequestError('Vui long chon nha cung cap khi tong hop nhieu phieu de xuat');
    }

    return Array.from(foundSupplierIds)[0];
};
