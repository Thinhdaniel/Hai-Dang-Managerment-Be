import { evaluateMislocation } from '@/constant/mislocation';

const toPlain = (value: any) => (typeof value?.toObject === 'function' ? value.toObject() : value);

const toId = (value: any) => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const toIso = (value: any) => {
    if (!value) return undefined;
    return new Date(value).toISOString();
};

const mapRole = (role?: string) => {
    if (role === 'admin' || role === 'director') return 'admin';
    if (role === 'manager') return 'manager';
    // Tổ trưởng phải giữ nguyên role để FE điều hướng đúng về màn nhập sản lượng;
    // nếu rơi vào 'staff' bên dưới thì FE tưởng là kỹ thuật và hiện app máy.
    if (role === 'line_leader') return 'line_leader';
    if (role === 'qc') return 'qc';
    return 'staff';
};

const mapAssetStatus = (status?: string) => {
    if (status === 'maintenance') return 'maintenance';
    if (status === 'broken') return 'broken';
    if (status === 'borrowing') return 'borrowing';
    if (status === 'storage') return 'storage';
    if (status === 'pending_disposal') return 'pending_disposal';
    if (status === 'disposed') return 'disposed';
    if (status === 'returned_to_partner') return 'returned_to_partner';
    return 'active';
};

const mapAssetOwnershipType = (ownershipType?: string) => {
    if (ownershipType === 'partner_borrowed') return 'partner_borrowed';
    if (ownershipType === 'rental') return 'rental';
    return 'owned';
};

export const serializeBrand = (input: any) => {
    const brand = toPlain(input);

    return {
        id: toId(brand),
        name: brand?.name,
        description: brand?.description,
        createdAt: toIso(brand?.createdAt),
        updatedAt: toIso(brand?.updatedAt),
    };
};

export const serializePlant = (input: any) => {
    const plant = toPlain(input);

    return {
        id: toId(plant),
        name: plant?.name,
        code: plant?.code,
        address: plant?.address ?? plant?.location,
        phone: plant?.phone,
        coordinates:
            typeof plant?.coordinates?.lat === 'number' && typeof plant?.coordinates?.lng === 'number'
                ? { lat: plant.coordinates.lat, lng: plant.coordinates.lng }
                : undefined,
        managerId: toId(plant?.managerId),
        assetCount: typeof plant?.assetCount === 'number' ? plant.assetCount : undefined,
        machineCount: typeof plant?.machineCount === 'number' ? plant.machineCount : undefined,
        createdAt: toIso(plant?.createdAt),
        updatedAt: toIso(plant?.updatedAt),
    };
};

export const serializeUser = (input: any) => {
    const user = toPlain(input);
    const plant =
        user?.plantId && typeof user.plantId === 'object' && user.plantId.name
            ? serializePlant(user.plantId)
            : undefined;

    return {
        id: toId(user),
        name: user?.name ?? user?.fullname ?? user?.username,
        email: user?.email,
        phone: user?.phone,
        role: mapRole(user?.role),
        plantId: plant?.id ?? toId(user?.plantId),
        plant,
        avatarUrl: user?.avatarUrl,
        isActive: user?.isActive !== false,
        createdAt: toIso(user?.createdAt),
        updatedAt: toIso(user?.updatedAt),
    };
};

const getDisplayName = (input: any) => {
    const value = toPlain(input);
    return value?.name ?? value?.fullname ?? value?.username ?? value?.email;
};

export const serializeAsset = (input: any) => {
    const asset = toPlain(input);
    const brand =
        asset?.brandId && typeof asset.brandId === 'object' && asset.brandId.name
            ? serializeBrand(asset.brandId)
            : undefined;
    const plant =
        asset?.plantId && typeof asset.plantId === 'object' && asset.plantId.name
            ? serializePlant(asset.plantId)
            : undefined;

    const ls = asset?.lastSeen;
    const lsPlant =
        ls?.plantId && typeof ls.plantId === 'object' && ls.plantId.name ? serializePlant(ls.plantId) : undefined;
    const lsActor = ls?.scannedBy && typeof ls.scannedBy === 'object' ? ls.scannedBy : undefined;
    const lastSeen =
        ls && (ls.plantId || ls.scannedAt)
            ? {
                  plantId: lsPlant?.id ?? toId(ls?.plantId),
                  plantName: lsPlant?.name,
                  plantCode: lsPlant?.code,
                  lat: ls?.lat,
                  lng: ls?.lng,
                  accuracy: ls?.accuracy,
                  distanceM: ls?.distanceM,
                  scannedById: lsActor ? toId(lsActor) : toId(ls?.scannedBy),
                  scannedByName: lsActor ? (lsActor.fullname ?? lsActor.name ?? lsActor.username) : undefined,
                  scannedAt: toIso(ls?.scannedAt),
              }
            : undefined;

    const officialPlantId = plant?.id ?? toId(asset?.plantId);
    const mislocation = evaluateMislocation(officialPlantId, ls);
    const locationMismatch = mislocation.mismatch
        ? {
              mismatch: true as const,
              officialPlantId,
              officialPlantName: plant?.name,
              actualPlantId: lastSeen?.plantId,
              actualPlantName: lastSeen?.plantName,
              distanceM: mislocation.distanceM,
              accuracy: mislocation.accuracy,
              scannedAt: lastSeen?.scannedAt,
          }
        : undefined;

    return {
        id: toId(asset),
        name: asset?.name,
        machineCode: asset?.machineCode,
        publicId: asset?.publicId,
        serial: asset?.serial ?? asset?.seri,
        type: asset?.type,
        model: asset?.model ?? asset?.type,
        brandId: brand?.id ?? toId(asset?.brandId),
        brand,
        plantId: plant?.id ?? toId(asset?.plantId),
        plant,
        area: asset?.area,
        status: mapAssetStatus(asset?.status),
        ownershipType: mapAssetOwnershipType(asset?.ownershipType),
        purchaseDate: toIso(asset?.purchaseDate),
        purchasePrice: asset?.purchasePrice,
        specifications: asset?.specifications ?? {},
        note: asset?.note,
        imageUrl: asset?.imageUrl,
        verificationImages:
            Array.isArray(asset?.verificationImages) && asset.verificationImages.length
                ? asset.verificationImages
                : undefined,
        lastMaintenanceDate: toIso(asset?.lastMaintenanceDate),
        nextMaintenanceDate: toIso(asset?.nextMaintenanceDate),
        lastSeen,
        locationMismatch,
        floorPos:
            asset?.floorPos && typeof asset.floorPos.x === 'number' && typeof asset.floorPos.y === 'number'
                ? { x: asset.floorPos.x, y: asset.floorPos.y }
                : undefined,
        createdAt: toIso(asset?.createdAt),
        updatedAt: toIso(asset?.updatedAt),
    };
};

export const serializePublicAsset = (input: any) => {
    const asset = toPlain(input);
    const facility =
        asset?.plantId && typeof asset.plantId === 'object' && asset.plantId.name
            ? serializePlant(asset.plantId)
            : undefined;

    return {
        publicId: asset?.publicId,
        name: asset?.name,
        machineCode: asset?.machineCode,
        serialNumber: asset?.serial ?? asset?.seri,
        model: asset?.model ?? asset?.type,
        status: mapAssetStatus(asset?.status),
        ownershipType: mapAssetOwnershipType(asset?.ownershipType),
        facility: facility
            ? {
                  name: facility.name,
                  code: facility.code,
              }
            : undefined,
    };
};

export const serializeMaintenance = (input: any) => {
    const maintenance = toPlain(input);
    const asset =
        maintenance?.assetId && typeof maintenance.assetId === 'object' && maintenance.assetId.name
            ? serializeAsset(maintenance.assetId)
            : undefined;
    const maintenancePlant =
        maintenance?.plantId && typeof maintenance.plantId === 'object' && maintenance.plantId.name
            ? serializePlant(maintenance.plantId)
            : undefined;
    // Danh sách máy trong phiếu (gồm máy chính) — fallback về [asset] cho phiếu cũ 1 máy
    const assets = Array.isArray(maintenance?.assetIds)
        ? maintenance.assetIds.filter((a: any) => a && typeof a === 'object' && a.name).map(serializeAsset)
        : [];

    return {
        id: toId(maintenance),
        assetId: asset?.id ?? toId(maintenance?.assetId),
        asset,
        assetIds: assets.length
            ? assets.map((a: any) => a.id)
            : [asset?.id ?? toId(maintenance?.assetId)].filter(Boolean),
        assets: assets.length ? assets : asset ? [asset] : [],
        // Snapshot cơ sở tại thời điểm phát sinh bảo trì
        plantId: maintenancePlant?.id ?? toId(maintenance?.plantId),
        plantName: maintenance?.plantName,
        areaAtCreation: maintenance?.areaAtCreation,
        plantIdBackfilled: maintenance?.plantIdBackfilled,
        type: maintenance?.type,
        repairMode: maintenance?.repairMode ?? 'internal',
        status: maintenance?.status,
        approvalStatus: maintenance?.approvalStatus ?? 'none',
        description: maintenance?.description,
        beforeImages: maintenance?.beforeImages ?? [],
        afterImages: maintenance?.afterImages ?? [],
        startDate: toIso(maintenance?.startDate),
        endDate: toIso(maintenance?.endDate),
        technician: maintenance?.technician,
        cost: maintenance?.cost,
        externalRepair: maintenance?.externalRepair
            ? {
                  vendorName: maintenance.externalRepair.vendorName,
                  sentOutAt: toIso(maintenance.externalRepair.sentOutAt),
                  expectedReturnAt: toIso(maintenance.externalRepair.expectedReturnAt),
                  returnedAt: toIso(maintenance.externalRepair.returnedAt),
                  estimateCost: maintenance.externalRepair.estimateCost,
                  actualCost: maintenance.externalRepair.actualCost,
                  invoiceNo: maintenance.externalRepair.invoiceNo,
                  invoiceImageUrl: maintenance.externalRepair.invoiceImageUrl,
                  costItems: maintenance.externalRepair.costItems ?? [],
                  approvedBy: toId(maintenance.externalRepair.approvedBy),
                  approvedAt: toIso(maintenance.externalRepair.approvedAt),
                  rejectedBy: toId(maintenance.externalRepair.rejectedBy),
                  rejectedAt: toIso(maintenance.externalRepair.rejectedAt),
                  rejectReason: maintenance.externalRepair.rejectReason,
              }
            : undefined,
        note: maintenance?.note,
        createdBy: toId(maintenance?.createdBy),
        createdAt: toIso(maintenance?.createdAt),
        updatedAt: toIso(maintenance?.updatedAt),
    };
};

export const serializeTransfer = (input: any) => {
    const transfer = toPlain(input);
    const asset =
        transfer?.assetId && typeof transfer.assetId === 'object' && transfer.assetId.name
            ? serializeAsset(transfer.assetId)
            : undefined;
    const assets = Array.isArray(transfer?.assetIds)
        ? transfer.assetIds.filter((item: any) => item && typeof item === 'object' && item.name).map(serializeAsset)
        : [];
    const fromPlant =
        transfer?.fromPlantId && typeof transfer.fromPlantId === 'object' && transfer.fromPlantId.name
            ? serializePlant(transfer.fromPlantId)
            : undefined;
    const toPlant =
        transfer?.toPlantId && typeof transfer.toPlantId === 'object' && transfer.toPlantId.name
            ? serializePlant(transfer.toPlantId)
            : undefined;
    const sourceSnapshots = Array.isArray(transfer?.sourceSnapshots)
        ? transfer.sourceSnapshots.map((item: any) => ({
              assetId: toId(item?.assetId),
              plantId: toId(item?.plantId),
              area: item?.area,
              machineCode: item?.machineCode,
              name: item?.name,
          }))
        : [];

    return {
        id: toId(transfer),
        assetId: asset?.id ?? toId(transfer?.assetId),
        asset,
        assetIds: assets.length
            ? assets.map((item: any) => item.id)
            : [asset?.id ?? toId(transfer?.assetId)].filter(Boolean),
        assets: assets.length ? assets : asset ? [asset] : [],
        fromPlantId: fromPlant?.id ?? toId(transfer?.fromPlantId),
        fromPlant,
        fromArea: transfer?.fromArea,
        sourceSnapshots,
        toPlantId: toPlant?.id ?? toId(transfer?.toPlantId),
        toPlant,
        toArea: transfer?.toArea,
        status: transfer?.status,
        reason: transfer?.reason,
        transferDate: toIso(transfer?.transferDate),
        approvedBy: toId(transfer?.approvedBy),
        approvedAt: toIso(transfer?.approvedAt),
        completedBy: toId(transfer?.completedBy),
        completedAt: toIso(transfer?.completedAt),
        note: transfer?.note,
        rejectReason: transfer?.rejectReason,
        receivedBy: transfer?.receivedBy,
        handoverImages: transfer?.handoverImages ?? [],
        cancelledBy: toId(transfer?.cancelledBy),
        cancelledAt: toIso(transfer?.cancelledAt),
        cancelReason: transfer?.cancelReason,
        createdBy: toId(transfer?.createdBy),
        createdAt: toIso(transfer?.createdAt),
        updatedAt: toIso(transfer?.updatedAt),
    };
};

export const serializeBorrowing = (input: any) => {
    const borrowing = toPlain(input);
    const asset =
        borrowing?.assetId && typeof borrowing.assetId === 'object' && borrowing.assetId.name
            ? serializeAsset(borrowing.assetId)
            : undefined;
    const batch =
        borrowing?.batchId && typeof borrowing.batchId === 'object' && borrowing.batchId.code
            ? serializeBorrowingBatch(borrowing.batchId)
            : undefined;
    const borrower =
        borrowing?.borrowerId && typeof borrowing.borrowerId === 'object' && borrowing.borrowerId.email
            ? serializeUser(borrowing.borrowerId)
            : undefined;

    return {
        id: toId(borrowing),
        assetId: asset?.id ?? toId(borrowing?.assetId),
        asset,
        batchId: batch?.id ?? toId(borrowing?.batchId),
        batch,
        qrLabelId: toId(borrowing?.qrLabelId),
        borrowerId: borrower?.id ?? toId(borrowing?.borrowerId),
        borrower,
        borrowerName: borrowing?.borrowerName ?? borrower?.name,
        type: borrowing?.type,
        borrowTime: toIso(borrowing?.borrowTime),
        returnTime: toIso(borrowing?.returnTime),
        expectedReturnTime: toIso(borrowing?.expectedReturnTime),
        status: borrowing?.status,
        partnerMachineCode: borrowing?.partnerMachineCode,
        purpose: borrowing?.purpose,
        partnerName: borrowing?.partnerName,
        location: borrowing?.location,
        cost: borrowing?.cost,
        note: borrowing?.note,
        returnNote: borrowing?.returnNote,
        receiveCondition: borrowing?.receiveCondition,
        receiveNote: borrowing?.receiveNote,
        returnCondition: borrowing?.returnCondition,
        qrReturnAction: borrowing?.qrReturnAction,
        qrReturnNote: borrowing?.qrReturnNote,
        qrRemovedAt: toIso(borrowing?.qrRemovedAt),
        qrRemovedBy: toId(borrowing?.qrRemovedBy),
        returnedInBatchAt: toIso(borrowing?.returnedInBatchAt),
        assetStatusBefore: borrowing?.assetStatusBefore,
        createdBy: toId(borrowing?.createdBy),
        returnedBy: toId(borrowing?.returnedBy),
        createdAt: toIso(borrowing?.createdAt),
        updatedAt: toIso(borrowing?.updatedAt),
    };
};

export const serializeBorrowingBatch = (input: any) => {
    const batch = toPlain(input);
    const plant =
        batch?.plantId && typeof batch.plantId === 'object' && batch.plantId.name
            ? serializePlant(batch.plantId)
            : undefined;
    const qrBatch =
        batch?.qrBatchId && typeof batch.qrBatchId === 'object' && batch.qrBatchId.code
            ? toPlain(batch.qrBatchId)
            : undefined;

    return {
        id: toId(batch),
        code: batch?.code,
        type: batch?.type,
        status: batch?.status,
        partnerName: batch?.partnerName,
        contractNo: batch?.contractNo,
        plantId: plant?.id ?? toId(batch?.plantId),
        plant,
        area: batch?.area,
        borrowTime: toIso(batch?.borrowTime),
        expectedReturnTime: toIso(batch?.expectedReturnTime),
        plannedQuantity: batch?.plannedQuantity ?? 0,
        qrBatchId: qrBatch ? toId(qrBatch) : toId(batch?.qrBatchId),
        qrBatch: qrBatch
            ? {
                  id: toId(qrBatch),
                  code: qrBatch.code,
                  quantity: qrBatch.quantity,
                  status: qrBatch.status,
                  printedAt: toIso(qrBatch.printedAt),
              }
            : undefined,
        labelPolicy: batch?.labelPolicy ?? 'temporary',
        removeQrOnReturn: batch?.removeQrOnReturn !== false,
        note: batch?.note,
        receivedCount: batch?.receivedCount,
        activeCount: batch?.activeCount,
        returnedCount: batch?.returnedCount,
        unusedQrCount: batch?.unusedQrCount,
        createdBy: toId(batch?.createdBy),
        updatedBy: toId(batch?.updatedBy),
        closedBy: toId(batch?.closedBy),
        closedAt: toIso(batch?.closedAt),
        createdAt: toIso(batch?.createdAt),
        updatedAt: toIso(batch?.updatedAt),
    };
};

export const serializeAssetDisposalBatch = (input: any) => {
    const batch = toPlain(input);
    const plant =
        batch?.plantId && typeof batch.plantId === 'object' && batch.plantId.name
            ? serializePlant(batch.plantId)
            : undefined;

    return {
        id: toId(batch),
        code: batch?.code,
        plantId: plant?.id ?? toId(batch?.plantId),
        plant,
        area: batch?.area,
        status: batch?.status,
        reason: batch?.reason,
        note: batch?.note,
        submittedBy: toId(batch?.submittedBy),
        submittedByName: getDisplayName(batch?.submittedBy),
        submittedAt: toIso(batch?.submittedAt),
        approvedBy: toId(batch?.approvedBy),
        approvedByName: getDisplayName(batch?.approvedBy),
        approvedAt: toIso(batch?.approvedAt),
        approvalNote: batch?.approvalNote,
        completedBy: toId(batch?.completedBy),
        completedByName: getDisplayName(batch?.completedBy),
        completedAt: toIso(batch?.completedAt),
        cancelledBy: toId(batch?.cancelledBy),
        cancelledByName: getDisplayName(batch?.cancelledBy),
        cancelledAt: toIso(batch?.cancelledAt),
        cancelReason: batch?.cancelReason,
        totalItems: batch?.totalItems,
        assetItems: batch?.assetItems,
        externalItems: batch?.externalItems,
        pendingItems: batch?.pendingItems,
        checkedItems: batch?.checkedItems,
        approvedItems: batch?.approvedItems,
        disposedItems: batch?.disposedItems,
        keptItems: batch?.keptItems,
        createdBy: toId(batch?.createdBy),
        createdByName: getDisplayName(batch?.createdBy),
        updatedBy: toId(batch?.updatedBy),
        updatedByName: getDisplayName(batch?.updatedBy),
        createdAt: toIso(batch?.createdAt),
        updatedAt: toIso(batch?.updatedAt),
    };
};

export const serializeAssetDisposalItem = (input: any) => {
    const item = toPlain(input);
    const asset =
        item?.assetId && typeof item.assetId === 'object' && item.assetId.name
            ? serializeAsset(item.assetId)
            : undefined;
    const plant =
        item?.plantId && typeof item.plantId === 'object' && item.plantId.name
            ? serializePlant(item.plantId)
            : undefined;
    const qrLabel = item?.qrLabelId && typeof item.qrLabelId === 'object' ? toPlain(item.qrLabelId) : undefined;
    const batch =
        item?.batchId && typeof item.batchId === 'object' && item.batchId.code
            ? serializeAssetDisposalBatch(item.batchId)
            : undefined;

    return {
        id: toId(item),
        batchId: batch?.id ?? toId(item?.batchId),
        batch,
        sourceType: item?.sourceType,
        assetId: asset?.id ?? toId(item?.assetId),
        asset,
        qrLabelId: qrLabel ? toId(qrLabel) : toId(item?.qrLabelId),
        qrLabel: qrLabel
            ? {
                  id: toId(qrLabel),
                  publicId: qrLabel.publicId,
                  status: qrLabel.status,
              }
            : undefined,
        publicId: item?.publicId,
        machineCode: item?.machineCode ?? asset?.machineCode,
        name: item?.name ?? asset?.name,
        type: item?.type ?? asset?.type,
        model: item?.model ?? asset?.model,
        serial: item?.serial ?? asset?.serial,
        plantId: plant?.id ?? asset?.plantId ?? toId(item?.plantId),
        plant: plant ?? asset?.plant,
        area: item?.area ?? asset?.area,
        condition: item?.condition,
        reason: item?.reason,
        suggestedAction: item?.suggestedAction,
        estimatedValue: item?.estimatedValue,
        finalValue: item?.finalValue,
        photos: item?.photos ?? [],
        status: item?.status,
        previousAssetStatus: item?.previousAssetStatus,
        checkedBy: toId(item?.checkedBy),
        checkedByName: getDisplayName(item?.checkedBy),
        checkedAt: toIso(item?.checkedAt),
        disposedAt: toIso(item?.disposedAt),
        note: item?.note,
        createdBy: toId(item?.createdBy),
        createdByName: getDisplayName(item?.createdBy),
        updatedBy: toId(item?.updatedBy),
        updatedByName: getDisplayName(item?.updatedBy),
        createdAt: toIso(item?.createdAt),
        updatedAt: toIso(item?.updatedAt),
    };
};
