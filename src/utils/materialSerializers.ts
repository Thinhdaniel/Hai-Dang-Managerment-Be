import { serializePlant, serializeUser } from './serializers';

const toPlain = (value: any) => (typeof value?.toObject === 'function' ? value.toObject() : value);

const toId = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if (typeof value.toHexString === 'function') return value.toHexString();
        if (typeof value.id === 'string' && value.id) return value.id;
        if (value._id && value._id !== value) return toId(value._id);
        if (typeof value.toString === 'function') {
            const stringValue = value.toString();
            if (stringValue && stringValue !== '[object Object]') {
                return stringValue;
            }
        }
        return undefined;
    }
    return String(value);
};

const toIso = (value: any) => {
    if (!value) return undefined;
    return new Date(value).toISOString();
};

export const serializeMaterial = (input: any) => {
    const material = toPlain(input);
    const createdBy =
        material?.createdBy && typeof material.createdBy === 'object' && material.createdBy.email
            ? serializeUser(material.createdBy)
            : undefined;
    const updatedBy =
        material?.updatedBy && typeof material.updatedBy === 'object' && material.updatedBy.email
            ? serializeUser(material.updatedBy)
            : undefined;

    return {
        id: toId(material),
        name: material?.name,
        code: material?.code,
        category: material?.category,
        unit: material?.unit,
        description: material?.description,
        minStockLevel: material?.minStockLevel ?? 0,
        trackInventory: material?.trackInventory !== false,
        isActive: material?.isActive !== false,
        totalCurrentStock: typeof material?.totalCurrentStock === 'number' ? material.totalCurrentStock : undefined,
        lowStock:
            typeof material?.lowStock === 'boolean'
                ? material.lowStock
                : typeof material?.totalCurrentStock === 'number'
                  ? material.totalCurrentStock < (material?.minStockLevel ?? 0)
                  : undefined,
        createdBy: createdBy ?? toId(material?.createdBy),
        updatedBy: updatedBy ?? toId(material?.updatedBy),
        createdAt: toIso(material?.createdAt),
        updatedAt: toIso(material?.updatedAt),
    };
};

export const serializeSupplier = (input: any) => {
    const supplier = toPlain(input);
    const createdBy =
        supplier?.createdBy && typeof supplier.createdBy === 'object' && supplier.createdBy.email
            ? serializeUser(supplier.createdBy)
            : undefined;
    const updatedBy =
        supplier?.updatedBy && typeof supplier.updatedBy === 'object' && supplier.updatedBy.email
            ? serializeUser(supplier.updatedBy)
            : undefined;

    return {
        id: toId(supplier),
        name: supplier?.name,
        code: supplier?.code,
        contactName: supplier?.contactName,
        phone: supplier?.phone,
        address: supplier?.address,
        supplyTypes: supplier?.supplyTypes ?? [],
        isActive: supplier?.isActive !== false,
        createdBy: createdBy ?? toId(supplier?.createdBy),
        updatedBy: updatedBy ?? toId(supplier?.updatedBy),
        createdAt: toIso(supplier?.createdAt),
        updatedAt: toIso(supplier?.updatedAt),
    };
};

const serializePurchaseRequestItem = (input: any) => {
    const item = toPlain(input);
    const material =
        item?.materialId && typeof item.materialId === 'object' && item.materialId.name ? serializeMaterial(item.materialId) : undefined;
    const supplier =
        item?.supplierId && typeof item.supplierId === 'object' && item.supplierId.name ? serializeSupplier(item.supplierId) : undefined;

    return {
        materialId: material?.id ?? toId(item?.materialId),
        material,
        materialName: item?.materialName ?? material?.name,
        unit: item?.unit ?? material?.unit,
        proposedBy: item?.proposedBy,
        purpose: item?.purpose,
        plantId: toId(item?.plantId),
        quantityRequested: item?.quantityRequested ?? 0,
        quantityApproved: item?.quantityApproved,
        quantityOrdered: item?.quantityOrdered,
        unitPrice: item?.unitPrice,
        totalPrice: item?.totalPrice,
        vatRate: item?.vatRate ?? 0.08,
        vatAmount: item?.vatAmount,
        totalWithVat: item?.totalWithVat,
        orderDate: toIso(item?.orderDate),
        receivedDate: toIso(item?.receivedDate),
        supplierName: item?.supplierName ?? supplier?.name,
        supplierNote: item?.supplierNote,
        estimatedPrice: item?.estimatedPrice,
        estimatedTotal: item?.estimatedTotal,
        supplierId: supplier?.id ?? toId(item?.supplierId),
        supplier,
        catalogStatus: item?.catalogStatus ?? (item?.materialId ? 'matched' : 'unmatched'),
        note: item?.note,
    };
};

export const serializePurchaseRequest = (input: any) => {
    const request = toPlain(input);
    const plant =
        request?.plantId && typeof request.plantId === 'object' && request.plantId.name
            ? serializePlant(request.plantId)
            : undefined;
    const fromPlant =
        request?.fromPlantId && typeof request.fromPlantId === 'object' && request.fromPlantId.name
            ? serializePlant(request.fromPlantId)
            : undefined;
    const toPlant =
        request?.toPlantId && typeof request.toPlantId === 'object' && request.toPlantId.name
            ? serializePlant(request.toPlantId)
            : undefined;
    const requestedBy =
        request?.requestedBy && typeof request.requestedBy === 'object' && request.requestedBy.email
            ? serializeUser(request.requestedBy)
            : undefined;
    const approvedBy =
        request?.approvedBy && typeof request.approvedBy === 'object' && request.approvedBy.email
            ? serializeUser(request.approvedBy)
            : undefined;

    return {
        id: toId(request),
        requestCode: request?.requestCode,
        requestType: request?.requestType,
        plantId: plant?.id ?? toId(request?.plantId),
        plant,
        fromPlantId: fromPlant?.id ?? toId(request?.fromPlantId),
        fromPlant,
        toPlantId: toPlant?.id ?? toId(request?.toPlantId),
        toPlant,
        requestedBy: requestedBy ?? toId(request?.requestedBy),
        approvedBy: approvedBy ?? toId(request?.approvedBy),
        status: request?.status,
        items: Array.isArray(request?.items) ? request.items.map(serializePurchaseRequestItem) : [],
        totalEstimated: request?.totalEstimated ?? 0,
        totalActual: request?.totalActual ?? 0,
        totalWithVat: request?.totalWithVat ?? 0,
        requestMonth: request?.requestMonth,
        requestYear: request?.requestYear,
        requestDate: toIso(request?.requestDate),
        approvedAt: toIso(request?.approvedAt),
        rejectedReason: request?.rejectedReason,
        note: request?.note,
        createdAt: toIso(request?.createdAt),
        updatedAt: toIso(request?.updatedAt),
    };
};

const serializePurchaseOrderItem = (input: any) => {
    const item = toPlain(input);
    return {
        purchaseRequestId: toId(item?.purchaseRequestId),
        purchaseRequestCode: item?.purchaseRequestCode,
        materialId: toId(item?.materialId),
        materialName: item?.materialName,
        unit: item?.unit,
        quantityRequested: item?.quantityRequested ?? 0,
        quantityOrdered: item?.quantityOrdered ?? 0,
        quantityReceived: item?.quantityReceived ?? 0,
        quantityMissing: item?.quantityMissing ?? Math.max(0, Number(item?.quantityOrdered ?? 0) - Number(item?.quantityReceived ?? 0)),
        receiveStatus: item?.receiveStatus,
        unitPrice: item?.unitPrice ?? 0,
        totalPrice: item?.totalPrice ?? 0,
        vatRate: item?.vatRate ?? 0,
        vatAmount: item?.vatAmount ?? 0,
        totalWithVat: item?.totalWithVat ?? 0,
        supplierId: toId(item?.supplierId),
        supplierName: item?.supplierName ?? (item?.supplierId && typeof item.supplierId === 'object' ? item.supplierId.name : undefined),
        plantName: item?.plantName,
        proposedBy: item?.proposedBy,
        purpose: item?.purpose,
        catalogStatus: item?.catalogStatus ?? (item?.materialId ? 'matched' : 'unmatched'),
        quantityInventoried: item?.quantityInventoried ?? 0,
        inventoryStatus: item?.inventoryStatus ?? 'pending',
        inventorySkipReason: item?.inventorySkipReason,
        note: item?.note,
    };
};

export const serializePurchaseOrder = (input: any) => {
    const order = toPlain(input);
    const createdBy = order?.createdBy && typeof order.createdBy === 'object' && order.createdBy.email
        ? serializeUser(order.createdBy) : undefined;
    const orderedBy = order?.orderedBy && typeof order.orderedBy === 'object' && order.orderedBy.email
        ? serializeUser(order.orderedBy) : undefined;
    const receivedBy = order?.receivedBy && typeof order.receivedBy === 'object' && order.receivedBy.email
        ? serializeUser(order.receivedBy) : undefined;

    return {
        id: toId(order),
        orderCode: order?.orderCode,
        purchaseRequestIds: Array.isArray(order?.purchaseRequestIds) ? order.purchaseRequestIds.map(toId) : [],
        purchaseRequestCodes: order?.purchaseRequestCodes ?? [],
        plantId: toId(order?.plantId),
        status: order?.status,
        items: Array.isArray(order?.items) ? order.items.map(serializePurchaseOrderItem) : [],
        totalAmount: order?.totalAmount ?? 0,
        totalVat: order?.totalVat ?? 0,
        totalWithVat: order?.totalWithVat ?? 0,
        createdBy: createdBy ?? toId(order?.createdBy),
        orderedBy: orderedBy ?? toId(order?.orderedBy),
        orderedAt: toIso(order?.orderedAt),
        receivedBy: receivedBy ?? toId(order?.receivedBy),
        receivedAt: toIso(order?.receivedAt),
        note: order?.note,
        createdAt: toIso(order?.createdAt),
        updatedAt: toIso(order?.updatedAt),
    };
};

export const serializePurchaseShortage = (input: any) => {
    const shortage = toPlain(input);
    const quantityMissing = Number(shortage?.quantityMissing ?? 0);
    const quantityResolved = Number(shortage?.quantityResolved ?? 0);

    return {
        id: toId(shortage),
        originalPurchaseOrderId: toId(shortage?.originalPurchaseOrderId),
        originalPurchaseOrderCode: shortage?.originalPurchaseOrderCode,
        originalItemIndex: shortage?.originalItemIndex,
        supplierId: toId(shortage?.supplierId),
        supplierName: shortage?.supplierName,
        materialId: toId(shortage?.materialId),
        materialName: shortage?.materialName,
        unit: shortage?.unit,
        quantityMissing,
        quantityResolved,
        quantityOutstanding: Math.max(0, quantityMissing - quantityResolved),
        status: shortage?.status,
        resolutions: Array.isArray(shortage?.resolutions)
            ? shortage.resolutions.map((resolution: any) => ({
                  purchaseOrderId: toId(resolution?.purchaseOrderId),
                  purchaseOrderCode: resolution?.purchaseOrderCode,
                  quantity: resolution?.quantity ?? 0,
                  resolvedBy: toId(resolution?.resolvedBy),
                  resolvedAt: toIso(resolution?.resolvedAt),
                  note: resolution?.note,
              }))
            : [],
        note: shortage?.note,
        createdAt: toIso(shortage?.createdAt),
        updatedAt: toIso(shortage?.updatedAt),
    };
};

export const serializeStockTransaction = (input: any) => {
    const transaction = toPlain(input);
    const material =
        transaction?.materialId && typeof transaction.materialId === 'object' && transaction.materialId.name
            ? serializeMaterial(transaction.materialId)
            : undefined;
    const plant =
        transaction?.plantId && typeof transaction.plantId === 'object' && transaction.plantId.name
            ? serializePlant(transaction.plantId)
            : undefined;
    const performedBy =
        transaction?.performedBy && typeof transaction.performedBy === 'object' && transaction.performedBy.email
            ? serializeUser(transaction.performedBy)
            : undefined;

    return {
        id: toId(transaction),
        type: transaction?.type,
        materialId: material?.id ?? toId(transaction?.materialId),
        material,
        materialName: transaction?.materialName ?? material?.name,
        plantId: plant?.id ?? toId(transaction?.plantId),
        plant,
        quantity: transaction?.quantity ?? 0,
        stockBefore: transaction?.stockBefore,
        stockAfter: transaction?.stockAfter,
        relatedId: toId(transaction?.relatedId),
        relatedType: transaction?.relatedType,
        performedBy: performedBy ?? toId(transaction?.performedBy),
        note: transaction?.note,
        createdAt: toIso(transaction?.createdAt),
    };
};

export const serializeInventoryStock = (input: any) => {
    const stock = toPlain(input);
    const material =
        stock?.materialId && typeof stock.materialId === 'object' && stock.materialId.name ? serializeMaterial(stock.materialId) : undefined;
    const plant =
        stock?.plantId && typeof stock.plantId === 'object' && stock.plantId.name ? serializePlant(stock.plantId) : undefined;

    const currentStock = stock?.currentStock ?? 0;
    const minStockLevel = stock?.minStockLevel ?? material?.minStockLevel ?? 0;

    return {
        id: toId(stock?._id) ?? [toId(stock?.materialId), toId(stock?.plantId)].filter(Boolean).join(':'),
        materialId: material?.id ?? toId(stock?.materialId),
        material,
        plantId: plant?.id ?? toId(stock?.plantId),
        plant,
        currentStock,
        minStockLevel,
        lowStock: currentStock < minStockLevel,
        lastUpdated: toIso(stock?.lastUpdated ?? stock?.updatedAt),
    };
};

const serializeDistributionRecordItem = (input: any) => {
    const item = toPlain(input);
    const material =
        item?.materialId && typeof item.materialId === 'object' && item.materialId.name ? serializeMaterial(item.materialId) : undefined;

    return {
        materialId: material?.id ?? toId(item?.materialId),
        material,
        materialName: item?.materialName ?? material?.name,
        unit: item?.unit ?? material?.unit,
        quantityRequested: item?.quantityRequested,
        quantity: item?.quantity ?? 0,
        unitPrice: item?.unitPrice,
        totalPrice: item?.totalPrice,
        vatRate: item?.vatRate,
        vatAmount: item?.vatAmount,
        totalWithVat: item?.totalWithVat,
        catalogStatus: item?.catalogStatus ?? (item?.materialId ? 'matched' : 'unmatched'),
        quantityInventoried: item?.quantityInventoried ?? 0,
        inventoryStatus: item?.inventoryStatus ?? 'pending',
        inventorySkipReason: item?.inventorySkipReason,
        adjustReason: item?.adjustReason,
        note: item?.note,
    };
};

export const serializeDistributionRecord = (input: any) => {
    const distribution = toPlain(input);
    const fromPlant =
        distribution?.fromPlantId && typeof distribution.fromPlantId === 'object' && distribution.fromPlantId.name
            ? serializePlant(distribution.fromPlantId)
            : undefined;
    const toPlant =
        distribution?.toPlantId && typeof distribution.toPlantId === 'object' && distribution.toPlantId.name
            ? serializePlant(distribution.toPlantId)
            : undefined;
    const purchaseOrder =
        distribution?.purchaseOrderId && typeof distribution.purchaseOrderId === 'object' && distribution.purchaseOrderId.orderCode
            ? serializePurchaseOrder(distribution.purchaseOrderId)
            : undefined;
    const supplyRequest =
        distribution?.supplyRequestId && typeof distribution.supplyRequestId === 'object' && distribution.supplyRequestId.requestCode
            ? serializePurchaseRequest(distribution.supplyRequestId)
            : undefined;
    const distributedBy =
        distribution?.distributedBy && typeof distribution.distributedBy === 'object' && distribution.distributedBy.email
            ? serializeUser(distribution.distributedBy)
            : undefined;
    const confirmedBy =
        distribution?.confirmedBy && typeof distribution.confirmedBy === 'object' && distribution.confirmedBy.email
            ? serializeUser(distribution.confirmedBy)
            : undefined;

    return {
        id: toId(distribution),
        distributionCode: distribution?.distributionCode,
        distributionType: distribution?.distributionType ?? 'facility_transfer',
        fromPlantId: fromPlant?.id ?? toId(distribution?.fromPlantId),
        fromPlant,
        toPlantId: toPlant?.id ?? toId(distribution?.toPlantId),
        toPlant,
        purchaseOrderId: purchaseOrder?.id ?? toId(distribution?.purchaseOrderId),
        purchaseOrder,
        supplyRequestId: supplyRequest?.id ?? toId(distribution?.supplyRequestId),
        supplyRequest,
        items: Array.isArray(distribution?.items) ? distribution.items.map(serializeDistributionRecordItem) : [],
        status: distribution?.status,
        distributedBy: distributedBy ?? toId(distribution?.distributedBy),
        distributedAt: toIso(distribution?.distributedAt),
        confirmedBy: confirmedBy ?? toId(distribution?.confirmedBy),
        confirmedAt: toIso(distribution?.confirmedAt),
        requesterName: distribution?.requesterName,
        targetDepartment: distribution?.targetDepartment,
        targetLine: distribution?.targetLine,
        note: distribution?.note,
        createdAt: toIso(distribution?.createdAt),
        updatedAt: toIso(distribution?.updatedAt),
    };
};
