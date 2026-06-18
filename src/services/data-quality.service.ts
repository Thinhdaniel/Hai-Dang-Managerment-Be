import { ROLE_GROUPS } from '@/constant/permissions';
import Asset from '@/models/Asset';
import InventoryStock from '@/models/InventoryStock';
import Maintenance from '@/models/Maintenance';
import Material from '@/models/Material';
import Plant from '@/models/Plant';
import QrLabel from '@/models/QrLabel';
import User from '@/models/User';
import customResponse from '@/utils/response';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

type Severity = 'critical' | 'warning' | 'info';
type CategoryKey = 'assets' | 'materials' | 'qr' | 'plants' | 'users' | 'maintenance';

type DataQualityRecord = {
    id: string;
    label: string;
    code?: string;
    meta?: string;
    path?: string;
};

type DataQualityCheck = {
    key: string;
    title: string;
    severity: Severity;
    count: number;
    total: number;
    ratio: number;
    description: string;
    action: string;
    records: DataQualityRecord[];
};

const SAMPLE_LIMIT = 8;

const nonDeleted = { isDeleted: { $ne: true } };
const activeNonDeleted = { ...nonDeleted, isActive: { $ne: false } };
const missingText = (field: string) => ({
    $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }],
});
const missingRef = (field: string) => ({
    $or: [{ [field]: { $exists: false } }, { [field]: null }],
});
const ratio = (count: number, total: number) => (total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0);

const toId = (value: any) => String(value?._id ?? value?.id ?? value ?? '');
const getPlantName = (value: any) =>
    value?.plantId && typeof value.plantId === 'object'
        ? [value.plantId.code, value.plantId.name].filter(Boolean).join(' - ')
        : undefined;

const assetRecord = (asset: any): DataQualityRecord => ({
    id: toId(asset),
    label: asset?.name || asset?.machineCode || 'Máy chưa có tên',
    code: asset?.machineCode,
    meta: getPlantName(asset) || asset?.area || asset?.status,
    path: `/assets/${toId(asset)}`,
});

const materialRecord = (material: any): DataQualityRecord => ({
    id: toId(material),
    label: material?.name || 'Vật tư chưa có tên',
    code: material?.code,
    meta: [material?.unit, material?.category].filter(Boolean).join(' · ') || undefined,
    path: '/materials',
});

const qrRecord = (label: any): DataQualityRecord => ({
    id: toId(label),
    label: label?.publicId || 'Tem QR',
    code: label?.status,
    meta: label?.plannedPlantId?.name || label?.plannedArea || label?.type,
    path: '/qr-labels',
});

const plantRecord = (plant: any): DataQualityRecord => ({
    id: toId(plant),
    label: plant?.name || 'Cơ sở chưa có tên',
    code: plant?.code,
    meta: plant?.address,
    path: '/plants',
});

const userRecord = (user: any): DataQualityRecord => ({
    id: toId(user),
    label: user?.fullname || user?.username || user?.email || 'Người dùng',
    code: user?.role,
    meta: user?.email,
    path: '/users',
});

const maintenanceRecord = (item: any): DataQualityRecord => ({
    id: toId(item),
    label: item?.assetId?.name || item?.description || 'Phiếu bảo trì',
    code: item?.assetId?.machineCode,
    meta: [item?.externalRepair?.vendorName, item?.status, item?.approvalStatus].filter(Boolean).join(' · ') || undefined,
    path: '/maintenances',
});

const countAndSample = async (
    model: any,
    filter: Record<string, any>,
    mapper: (value: any) => DataQualityRecord,
    populate?: Parameters<typeof model.find>[0]
) => {
    const [count, rows] = await Promise.all([
        model.countDocuments(filter),
        (() => {
            let query = model.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(SAMPLE_LIMIT).lean();
            if (populate) {
                query = query.populate(populate);
            }
            return query;
        })(),
    ]);

    return { count, records: rows.map(mapper) };
};

const duplicateGroups = async (
    model: any,
    match: Record<string, any>,
    normalizeExpression: Record<string, any>,
    sampleLabel: (item: any) => string,
    path: string
) => {
    const rows = await model.aggregate([
        { $match: match },
        {
            $group: {
                _id: normalizeExpression,
                count: { $sum: 1 },
                items: {
                    $push: {
                        id: '$_id',
                        label: '$name',
                        code: { $ifNull: ['$machineCode', '$code'] },
                        serial: '$serial',
                        unit: '$unit',
                    },
                },
            },
        },
        { $match: { _id: { $nin: [null, ''] }, count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: SAMPLE_LIMIT },
    ]);

    const count = rows.reduce((sum: number, row: any) => sum + Number(row.count || 0), 0);
    const records = rows.map((row: any) => ({
        id: String(row._id),
        label: sampleLabel(row),
        code: `Trùng ${row.count} bản ghi`,
        meta: (row.items ?? [])
            .slice(0, 3)
            .map((item: any) => item.code || item.serial || item.label || item.unit)
            .filter(Boolean)
            .join(', '),
        path,
    }));

    return { count, records };
};

const buildCheck = (
    key: string,
    title: string,
    severity: Severity,
    count: number,
    total: number,
    description: string,
    action: string,
    records: DataQualityRecord[]
): DataQualityCheck => ({
    key,
    title,
    severity,
    count,
    total,
    ratio: ratio(count, total),
    description,
    action,
    records,
});

const categoryScore = (checks: DataQualityCheck[], totalRecords: number) => {
    if (totalRecords <= 0) return 100;
    const weightedIssues = checks.reduce((sum, item) => {
        const weight = item.severity === 'critical' ? 3 : item.severity === 'warning' ? 1.5 : 0.7;
        return sum + item.count * weight;
    }, 0);
    return Math.max(0, Math.round(100 - (weightedIssues / Math.max(totalRecords, 1)) * 18));
};

const buildCategory = (key: CategoryKey, title: string, totalRecords: number, checks: DataQualityCheck[]) => {
    const issueCount = checks.reduce((sum, item) => sum + item.count, 0);
    return {
        key,
        title,
        totalRecords,
        issueCount,
        criticalCount: checks.filter((item) => item.severity === 'critical').reduce((sum, item) => sum + item.count, 0),
        warningCount: checks.filter((item) => item.severity === 'warning').reduce((sum, item) => sum + item.count, 0),
        infoCount: checks.filter((item) => item.severity === 'info').reduce((sum, item) => sum + item.count, 0),
        score: categoryScore(checks, totalRecords),
        checks,
    };
};

export const getDataQualityOverview = async (req: Request, res: Response, _next: NextFunction) => {
    if (!(ROLE_GROUPS.ADMIN_ONLY as readonly string[]).includes(String(req.role))) {
        return res.status(StatusCodes.FORBIDDEN).json(
            customResponse({
                data: null,
                message: 'Chi super admin moi duoc xem dashboard chat luong du lieu',
                status: StatusCodes.FORBIDDEN,
                success: false,
            })
        );
    }

    const [
        totalAssets,
        totalMaterials,
        totalQrLabels,
        totalPlants,
        totalUsers,
        totalMaintenances,
        assetsMissingQr,
        assetsMissingCore,
        assetsMissingArea,
        assetsDuplicateMachineCode,
        assetsDuplicateSerial,
        materialsMissingCode,
        materialsMissingCategory,
        materialsZeroMinStock,
        materialsDuplicateCode,
        materialsDuplicateNameUnit,
        materialsNoStockRows,
        qrPrintedUnused,
        qrAssignedWithoutAsset,
        plantsMissingCoordinates,
        plantsMissingManager,
        usersMissingPlant,
        usersNeverLoggedIn,
        maintenanceExternalMissingVendor,
        maintenanceExternalMissingExpectedReturn,
    ] = await Promise.all([
        Asset.countDocuments(nonDeleted),
        Material.countDocuments(nonDeleted),
        QrLabel.countDocuments(nonDeleted),
        Plant.countDocuments(nonDeleted),
        User.countDocuments(nonDeleted),
        Maintenance.countDocuments(nonDeleted),

        countAndSample(Asset, { ...nonDeleted, ...missingText('publicId') }, assetRecord, { path: 'plantId', select: 'name code' }),
        countAndSample(
            Asset,
            {
                ...nonDeleted,
                $or: [
                    ...missingText('name').$or,
                    ...missingText('machineCode').$or,
                    ...missingText('type').$or,
                    ...missingText('model').$or,
                    ...missingRef('brandId').$or,
                    ...missingRef('plantId').$or,
                    ...missingText('status').$or,
                    ...missingText('ownershipType').$or,
                ],
            },
            assetRecord,
            { path: 'plantId', select: 'name code' }
        ),
        countAndSample(Asset, { ...nonDeleted, ...missingText('area') }, assetRecord, { path: 'plantId', select: 'name code' }),
        duplicateGroups(
            Asset,
            { ...nonDeleted, machineCode: { $exists: true, $type: 'string', $ne: '' } },
            { $toUpper: { $trim: { input: '$machineCode' } } },
            (row) => `Mã máy ${row._id}`,
            '/assets'
        ),
        duplicateGroups(
            Asset,
            { ...nonDeleted, serial: { $exists: true, $type: 'string', $ne: '' } },
            { $toUpper: { $trim: { input: '$serial' } } },
            (row) => `Serial ${row._id}`,
            '/assets'
        ),

        countAndSample(Material, { ...nonDeleted, ...missingText('code') }, materialRecord),
        countAndSample(Material, { ...nonDeleted, ...missingText('category') }, materialRecord),
        countAndSample(Material, { ...nonDeleted, trackInventory: { $ne: false }, minStockLevel: { $lte: 0 } }, materialRecord),
        duplicateGroups(
            Material,
            { ...nonDeleted, code: { $exists: true, $type: 'string', $ne: '' } },
            { $toUpper: { $trim: { input: '$code' } } },
            (row) => `Mã vật tư ${row._id}`,
            '/materials'
        ),
        duplicateGroups(
            Material,
            { ...nonDeleted, name: { $exists: true, $type: 'string', $ne: '' } },
            {
                $concat: [
                    { $toUpper: { $trim: { input: '$name' } } },
                    ' / ',
                    { $toUpper: { $trim: { input: { $ifNull: ['$unit', ''] } } } },
                ],
            },
            (row) => `Tên/ĐVT ${row._id}`,
            '/materials'
        ),
        (async () => {
            const rows = await Material.aggregate([
                { $match: { ...nonDeleted, trackInventory: { $ne: false } } },
                {
                    $lookup: {
                        from: InventoryStock.collection.name,
                        let: { materialId: '$_id' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$materialId', '$$materialId'] },
                                    isDeleted: { $ne: true },
                                },
                            },
                            { $limit: 1 },
                        ],
                        as: 'stockRows',
                    },
                },
                { $match: { stockRows: { $size: 0 } } },
                { $sort: { updatedAt: -1, createdAt: -1 } },
                { $limit: SAMPLE_LIMIT },
                { $project: { name: 1, code: 1, unit: 1, category: 1 } },
            ]);
            const countRows = await Material.aggregate([
                { $match: { ...nonDeleted, trackInventory: { $ne: false } } },
                {
                    $lookup: {
                        from: InventoryStock.collection.name,
                        let: { materialId: '$_id' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$materialId', '$$materialId'] },
                                    isDeleted: { $ne: true },
                                },
                            },
                            { $limit: 1 },
                        ],
                        as: 'stockRows',
                    },
                },
                { $match: { stockRows: { $size: 0 } } },
                { $count: 'count' },
            ]);
            return { count: countRows[0]?.count ?? 0, records: rows.map(materialRecord) };
        })(),

        countAndSample(
            QrLabel,
            { ...nonDeleted, status: 'unused', printedAt: { $exists: true, $ne: null } },
            qrRecord,
            { path: 'plannedPlantId', select: 'name code' }
        ),
        countAndSample(
            QrLabel,
            { ...nonDeleted, status: 'assigned', ...missingRef('assetId') },
            qrRecord,
            { path: 'plannedPlantId', select: 'name code' }
        ),

        countAndSample(
            Plant,
            {
                ...nonDeleted,
                $or: [
                    { 'coordinates.lat': { $exists: false } },
                    { 'coordinates.lng': { $exists: false } },
                    { 'coordinates.lat': null },
                    { 'coordinates.lng': null },
                ],
            },
            plantRecord
        ),
        countAndSample(Plant, { ...nonDeleted, ...missingRef('managerId') }, plantRecord),

        countAndSample(User, { ...activeNonDeleted, role: { $ne: 'admin' }, ...missingRef('plantId') }, userRecord),
        countAndSample(User, { ...activeNonDeleted, lastLoginAt: { $exists: false } }, userRecord),

        countAndSample(
            Maintenance,
            { ...nonDeleted, repairMode: 'external', status: { $nin: ['completed', 'cancelled'] }, ...missingText('externalRepair.vendorName') },
            maintenanceRecord,
            { path: 'assetId', select: 'name machineCode' }
        ),
        countAndSample(
            Maintenance,
            {
                ...nonDeleted,
                repairMode: 'external',
                status: { $nin: ['completed', 'cancelled'] },
                ...missingRef('externalRepair.expectedReturnAt'),
            },
            maintenanceRecord,
            { path: 'assetId', select: 'name machineCode' }
        ),
    ]);

    const categories = [
        buildCategory('assets', 'Dữ liệu máy', totalAssets, [
            buildCheck(
                'assets.missingQr',
                'Máy chưa có QR/publicId',
                'critical',
                assetsMissingQr.count,
                totalAssets,
                'Máy chưa có mã QR sẽ không thể dùng tốt các luồng quét, kiểm kê và cập nhật nhanh.',
                'Tạo/gán tem QR hoặc kích hoạt tem trắng cho các máy này.',
                assetsMissingQr.records
            ),
            buildCheck(
                'assets.missingCore',
                'Máy thiếu thông tin bắt buộc',
                'critical',
                assetsMissingCore.count,
                totalAssets,
                'Thiếu tên, mã, loại/model, nhãn hiệu, cơ sở, trạng thái hoặc nguồn gốc làm hồ sơ máy không đủ tin cậy.',
                'Bổ sung hồ sơ máy trước khi dùng cho bảo trì/điều chuyển/kiểm kê.',
                assetsMissingCore.records
            ),
            buildCheck(
                'assets.missingArea',
                'Máy chưa có khu vực',
                'warning',
                assetsMissingArea.count,
                totalAssets,
                'Không có khu vực khiến kiểm kê QR và tìm máy ngoài xưởng khó chính xác.',
                'Chuẩn hóa khu vực theo từng cơ sở và cập nhật cho máy.',
                assetsMissingArea.records
            ),
            buildCheck(
                'assets.duplicateMachineCode',
                'Mã máy bị trùng',
                'critical',
                assetsDuplicateMachineCode.count,
                totalAssets,
                'Mã máy trùng làm sai báo cáo, bảo trì, điều chuyển và QR.',
                'Đổi mã máy trùng về mã duy nhất theo quy ước công ty.',
                assetsDuplicateMachineCode.records
            ),
            buildCheck(
                'assets.duplicateSerial',
                'Serial bị trùng',
                'critical',
                assetsDuplicateSerial.count,
                totalAssets,
                'Serial là số nhận dạng duy nhất của máy — về nguyên tắc không bao giờ được trùng. Trùng serial gần như chắc chắn là nhập sai hoặc trùng hồ sơ máy.',
                'Đối chiếu serial thực tế trên máy và sửa/gộp hồ sơ để mỗi serial là duy nhất.',
                assetsDuplicateSerial.records
            ),
        ]),
        buildCategory('materials', 'Dữ liệu vật tư', totalMaterials, [
            buildCheck(
                'materials.missingCode',
                'Vật tư thiếu mã',
                'critical',
                materialsMissingCode.count,
                totalMaterials,
                'Thiếu mã khiến đề xuất mua, tồn kho và đối soát dễ trùng/lẫn.',
                'Chuẩn hóa mã vật tư trước khi dùng cho mua hàng/cấp phát.',
                materialsMissingCode.records
            ),
            buildCheck(
                'materials.missingCategory',
                'Vật tư thiếu nhóm',
                'warning',
                materialsMissingCategory.count,
                totalMaterials,
                'Thiếu nhóm làm báo cáo tiêu hao và lọc danh mục kém hiệu quả.',
                'Bổ sung nhóm vật tư theo danh mục nội bộ.',
                materialsMissingCategory.records
            ),
            buildCheck(
                'materials.zeroMinStock',
                'Vật tư chưa có ngưỡng tồn tối thiểu',
                'warning',
                materialsZeroMinStock.count,
                totalMaterials,
                'Không có ngưỡng tồn thì hệ thống khó cảnh báo mua bù.',
                'Nhập minStockLevel cho vật tư có theo dõi tồn.',
                materialsZeroMinStock.records
            ),
            buildCheck(
                'materials.duplicateCode',
                'Mã vật tư bị trùng',
                'critical',
                materialsDuplicateCode.count,
                totalMaterials,
                'Mã vật tư trùng làm sai tồn kho và đề xuất mua.',
                'Gộp hoặc đổi mã để mỗi vật tư có một mã duy nhất.',
                materialsDuplicateCode.records
            ),
            buildCheck(
                'materials.duplicateNameUnit',
                'Tên + đơn vị tính có dấu hiệu trùng',
                'warning',
                materialsDuplicateNameUnit.count,
                totalMaterials,
                'Nhiều bản ghi cùng tên và đơn vị tính thường là dữ liệu bị nhập lặp.',
                'Rà lại để gộp vật tư tương đương.',
                materialsDuplicateNameUnit.records
            ),
            buildCheck(
                'materials.noStockRows',
                'Vật tư theo dõi tồn nhưng chưa có dòng tồn kho',
                'warning',
                materialsNoStockRows.count,
                totalMaterials,
                'Vật tư chưa khởi tạo tồn sẽ không phản ánh chính xác trong báo cáo tồn kho.',
                'Khởi tạo tồn kho theo cơ sở cho các vật tư này.',
                materialsNoStockRows.records
            ),
        ]),
        buildCategory('qr', 'Tem QR', totalQrLabels, [
            buildCheck(
                'qr.printedUnused',
                'Tem đã in nhưng chưa kích hoạt',
                'warning',
                qrPrintedUnused.count,
                totalQrLabels,
                'Tem in ra nhưng chưa gán máy là điểm rơi dễ lệch dữ liệu khi dán ngoài thực tế.',
                'Kích hoạt tem sau khi dán hoặc đánh dấu hỏng/mất nếu không dùng.',
                qrPrintedUnused.records
            ),
            buildCheck(
                'qr.assignedWithoutAsset',
                'Tem trạng thái đã gán nhưng thiếu máy',
                'critical',
                qrAssignedWithoutAsset.count,
                totalQrLabels,
                'Trạng thái tem và liên kết máy không khớp, dễ làm QR điều hướng sai.',
                'Rà lại lô tem và liên kết assetId.',
                qrAssignedWithoutAsset.records
            ),
        ]),
        buildCategory('plants', 'Cơ sở', totalPlants, [
            buildCheck(
                'plants.missingCoordinates',
                'Cơ sở thiếu tọa độ GPS',
                'warning',
                plantsMissingCoordinates.count,
                totalPlants,
                'Thiếu tọa độ làm tính năng phát hiện máy lệch vị trí kém chính xác.',
                'Cập nhật lat/lng cho từng cơ sở.',
                plantsMissingCoordinates.records
            ),
            buildCheck(
                'plants.missingManager',
                'Cơ sở chưa gán quản lý',
                'info',
                plantsMissingManager.count,
                totalPlants,
                'Không gán quản lý làm trách nhiệm dữ liệu theo cơ sở không rõ.',
                'Gán manager phụ trách dữ liệu cho từng cơ sở.',
                plantsMissingManager.records
            ),
        ]),
        buildCategory('users', 'Người dùng', totalUsers, [
            buildCheck(
                'users.missingPlant',
                'Người dùng chưa gán cơ sở',
                'warning',
                usersMissingPlant.count,
                totalUsers,
                'Tài khoản không có cơ sở dễ xem/ghi dữ liệu sai phạm vi.',
                'Gán cơ sở cho manager/staff/director theo phạm vi làm việc.',
                usersMissingPlant.records
            ),
            buildCheck(
                'users.neverLoggedIn',
                'Tài khoản chưa từng đăng nhập',
                'info',
                usersNeverLoggedIn.count,
                totalUsers,
                'Tài khoản chưa đăng nhập có thể là chưa rollout hoặc không còn dùng.',
                'Rà lại danh sách triển khai và khóa tài khoản không dùng.',
                usersNeverLoggedIn.records
            ),
        ]),
        buildCategory('maintenance', 'Bảo trì', totalMaintenances, [
            buildCheck(
                'maintenance.externalMissingVendor',
                'Phiếu sửa ngoài thiếu đơn vị sửa',
                'critical',
                maintenanceExternalMissingVendor.count,
                totalMaintenances,
                'Sửa ngoài thiếu đơn vị sửa làm chứng từ và đối soát không đủ tin cậy.',
                'Bổ sung vendorName cho các phiếu sửa ngoài đang mở.',
                maintenanceExternalMissingVendor.records
            ),
            buildCheck(
                'maintenance.externalMissingExpectedReturn',
                'Phiếu sửa ngoài thiếu ngày dự kiến trả',
                'warning',
                maintenanceExternalMissingExpectedReturn.count,
                totalMaintenances,
                'Không có ngày dự kiến trả thì hệ thống khó cảnh báo quá hạn sửa ngoài.',
                'Nhập expectedReturnAt cho phiếu sửa ngoài.',
                maintenanceExternalMissingExpectedReturn.records
            ),
        ]),
    ];

    const totalRecords = categories.reduce((sum, item) => sum + item.totalRecords, 0);
    const totalIssues = categories.reduce((sum, item) => sum + item.issueCount, 0);
    const criticalIssues = categories.reduce((sum, item) => sum + item.criticalCount, 0);
    const warningIssues = categories.reduce((sum, item) => sum + item.warningCount, 0);
    const infoIssues = categories.reduce((sum, item) => sum + item.infoCount, 0);
    const overallScore =
        categories.length > 0
            ? Math.round(categories.reduce((sum, item) => sum + item.score * Math.max(item.totalRecords, 1), 0) / categories.reduce((sum, item) => sum + Math.max(item.totalRecords, 1), 0))
            : 100;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                generatedAt: new Date().toISOString(),
                overallScore,
                summary: {
                    totalRecords,
                    totalIssues,
                    criticalIssues,
                    warningIssues,
                    infoIssues,
                    affectedCategories: categories.filter((item) => item.issueCount > 0).length,
                },
                categories,
            },
            message: 'Lay dashboard chat luong du lieu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
