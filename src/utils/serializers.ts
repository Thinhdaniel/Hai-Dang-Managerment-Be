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
    return 'staff';
};

const mapAssetStatus = (status?: string) => {
    if (status === 'maintenance') return 'maintenance';
    if (status === 'broken') return 'broken';
    if (status === 'borrowing') return 'borrowing';
    if (status === 'storage') return 'storage';
    return 'active';
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
        purchaseDate: toIso(asset?.purchaseDate),
        purchasePrice: asset?.purchasePrice,
        specifications: asset?.specifications ?? {},
        note: asset?.note,
        imageUrl: asset?.imageUrl,
        lastMaintenanceDate: toIso(asset?.lastMaintenanceDate),
        nextMaintenanceDate: toIso(asset?.nextMaintenanceDate),
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

    console.log('serializePublicAsset called for:', asset?.publicId, 'machineCode is:', asset?.machineCode);

    return {
        publicId: asset?.publicId,
        name: asset?.name,
        machineCode: asset?.machineCode,
        serialNumber: asset?.serial ?? asset?.seri,
        model: asset?.model ?? asset?.type,
        status: mapAssetStatus(asset?.status),
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

    return {
        id: toId(maintenance),
        assetId: asset?.id ?? toId(maintenance?.assetId),
        asset,
        type: maintenance?.type,
        status: maintenance?.status,
        description: maintenance?.description,
        startDate: toIso(maintenance?.startDate),
        endDate: toIso(maintenance?.endDate),
        technician: maintenance?.technician,
        cost: maintenance?.cost,
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
    const fromPlant =
        transfer?.fromPlantId && typeof transfer.fromPlantId === 'object' && transfer.fromPlantId.name
            ? serializePlant(transfer.fromPlantId)
            : undefined;
    const toPlant =
        transfer?.toPlantId && typeof transfer.toPlantId === 'object' && transfer.toPlantId.name
            ? serializePlant(transfer.toPlantId)
            : undefined;

    return {
        id: toId(transfer),
        assetId: asset?.id ?? toId(transfer?.assetId),
        asset,
        fromPlantId: fromPlant?.id ?? toId(transfer?.fromPlantId),
        fromPlant,
        fromArea: transfer?.fromArea,
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
    const borrower =
        borrowing?.borrowerId && typeof borrowing.borrowerId === 'object' && borrowing.borrowerId.email
            ? serializeUser(borrowing.borrowerId)
            : undefined;

    return {
        id: toId(borrowing),
        assetId: asset?.id ?? toId(borrowing?.assetId),
        asset,
        borrowerId: borrower?.id ?? toId(borrowing?.borrowerId),
        borrower,
        borrowerName: borrowing?.borrowerName ?? borrower?.name,
        type: borrowing?.type,
        borrowTime: toIso(borrowing?.borrowTime),
        returnTime: toIso(borrowing?.returnTime),
        status: borrowing?.status,
        purpose: borrowing?.purpose,
        partnerName: borrowing?.partnerName,
        location: borrowing?.location,
        cost: borrowing?.cost,
        note: borrowing?.note,
        returnNote: borrowing?.returnNote,
        assetStatusBefore: borrowing?.assetStatusBefore,
        createdBy: toId(borrowing?.createdBy),
        returnedBy: toId(borrowing?.returnedBy),
        createdAt: toIso(borrowing?.createdAt),
        updatedAt: toIso(borrowing?.updatedAt),
    };
};
