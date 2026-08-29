import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { BadRequestError, NotFoundError } from '@/errors/customError';
import Asset from '@/models/Asset';
import Maintenance from '@/models/Maintenance';
import Transfer from '@/models/Transfer';
import Borrowing from '@/models/Borrowing';
import AssetDisposalItem from '@/models/AssetDisposalItem';
import QrScanLog from '@/models/QrScanLog';
import { ASSET_OWNERSHIP_TYPE, ASSET_STATUS } from '@/constant/assetStatus';
import { ASSET_DISPOSAL_ITEM_STATUS } from '@/constant/assetDisposal';
import {
    serializeAsset,
    serializeAssetDisposalItem,
    serializeBorrowing,
    serializeMaintenance,
    serializeTransfer,
} from '@/utils/serializers';
import customResponse from '@/utils/response';

type Tone = 'blue' | 'emerald' | 'amber' | 'indigo' | 'slate' | 'rose' | 'violet';
type Severity = 'info' | 'success' | 'warning' | 'danger';

const STATUS_LABEL: Record<string, string> = {
    [ASSET_STATUS.ACTIVE]: 'Hoạt động',
    [ASSET_STATUS.MAINTENANCE]: 'Bảo trì',
    [ASSET_STATUS.BROKEN]: 'Hỏng / lỗi',
    [ASSET_STATUS.BORROWING]: 'Đang mượn',
    [ASSET_STATUS.LOANED_OUT]: 'Đang cho đối tác mượn',
    [ASSET_STATUS.STORAGE]: 'Tồn kho',
    [ASSET_STATUS.PENDING_DISPOSAL]: 'Chuẩn bị thanh lý',
    [ASSET_STATUS.DISPOSED]: 'Đã thanh lý',
    [ASSET_STATUS.RETURNED_TO_PARTNER]: 'Đã trả đối tác',
};

const OWNERSHIP_LABEL: Record<string, string> = {
    [ASSET_OWNERSHIP_TYPE.OWNED]: 'Máy công ty',
    [ASSET_OWNERSHIP_TYPE.PARTNER_BORROWED]: 'Máy mượn đối tác',
    [ASSET_OWNERSHIP_TYPE.RENTAL]: 'Máy thuê',
};

const MAINTENANCE_STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ xử lý',
    in_progress: 'Đang xử lý',
    completed: 'Hoàn thành',
    overdue: 'Quá hạn',
    cancelled: 'Đã hủy',
};

const TRANSFER_STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ duyệt',
    approved: 'Đã duyệt',
    completed: 'Hoàn tất',
    rejected: 'Từ chối',
    cancelled: 'Đã hủy',
};

const BORROWING_TYPE_LABEL: Record<string, string> = {
    internal: 'Mượn nội bộ',
    external: 'Mượn đối tác',
    rental: 'Thuê ngoài',
};

const DISPOSAL_STATUS_LABEL: Record<string, string> = {
    pending: 'Chờ rà soát',
    checked: 'Đã rà soát',
    approved: 'Đã duyệt',
    disposed: 'Đã thanh lý',
    kept: 'Giữ lại',
    cancelled: 'Đã hủy',
};

const openAssetFilter = (assetObjectId: mongoose.Types.ObjectId) => ({
    $or: [{ assetId: assetObjectId }, { assetIds: assetObjectId }],
});

const toIso = (value?: Date | string | null) => (value ? new Date(value).toISOString() : undefined);

const daysFromNow = (value?: Date | string | null) => {
    if (!value) return undefined;
    const diff = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(diff)) return undefined;
    return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
};

const buildHealth = ({
    asset,
    openMaintenanceCount,
    openTransferCount,
    activeBorrowing,
    activeDisposalCount,
    staleScanDays,
}: {
    asset: any;
    openMaintenanceCount: number;
    openTransferCount: number;
    activeBorrowing: any;
    activeDisposalCount: number;
    staleScanDays?: number;
}) => {
    if (asset.status === ASSET_STATUS.DISPOSED) {
        return {
            level: 'danger' as Severity,
            tone: 'rose' as Tone,
            label: 'Không được vận hành',
            summary: 'Máy đã thanh lý. Chỉ nên dùng QR để tra cứu hồ sơ và chứng từ thanh lý.',
        };
    }

    if (asset.status === ASSET_STATUS.PENDING_DISPOSAL || activeDisposalCount > 0) {
        return {
            level: 'danger' as Severity,
            tone: 'rose' as Tone,
            label: 'Đang trong luồng thanh lý',
            summary: 'Cần kiểm tra lô thanh lý trước khi tạo bảo trì hoặc điều chuyển mới.',
        };
    }

    if (asset.status === ASSET_STATUS.BROKEN) {
        return {
            level: 'danger' as Severity,
            tone: 'rose' as Tone,
            label: 'Cần xử lý sự cố',
            summary: 'Máy đang hỏng/lỗi. Ưu tiên tạo hoặc kiểm tra phiếu bảo trì tại hiện trường.',
        };
    }

    if (openMaintenanceCount > 0 || asset.status === ASSET_STATUS.MAINTENANCE) {
        return {
            level: 'warning' as Severity,
            tone: 'amber' as Tone,
            label: 'Đang theo dõi bảo trì',
            summary: 'Máy có phiếu bảo trì đang mở hoặc trạng thái bảo trì. Nên cập nhật kết quả sau khi sửa.',
        };
    }

    if (openTransferCount > 0) {
        return {
            level: 'warning' as Severity,
            tone: 'indigo' as Tone,
            label: 'Có lệnh điều chuyển mở',
            summary: 'Không nên tạo thêm lệnh chuyển mới trước khi kiểm tra lệnh hiện tại.',
        };
    }

    if (activeBorrowing) {
        return {
            level: 'info' as Severity,
            tone: 'violet' as Tone,
            label: 'Đang theo dõi mượn/thuê',
            summary: 'Cần kiểm tra hạn trả, đối tác và tình trạng QR trước khi trả máy.',
        };
    }

    if (typeof staleScanDays === 'number' && staleScanDays >= 30) {
        return {
            level: 'warning' as Severity,
            tone: 'slate' as Tone,
            label: 'Lâu chưa được quét xác nhận',
            summary: `Lần quét gần nhất đã cách ${staleScanDays} ngày. Nên xác nhận lại vị trí và khu vực thực tế.`,
        };
    }

    return {
        level: 'success' as Severity,
        tone: 'emerald' as Tone,
        label: 'Sẵn sàng vận hành',
        summary: 'Không thấy luồng mở nghiêm trọng. Có thể mở hồ sơ, báo hỏng hoặc cập nhật khu vực nếu cần.',
    };
};

const buildSuggestions = ({
    asset,
    openMaintenanceCount,
    openTransferCount,
    activeBorrowing,
    activeDisposalCount,
    canTransfer,
}: {
    asset: any;
    openMaintenanceCount: number;
    openTransferCount: number;
    activeBorrowing: any;
    activeDisposalCount: number;
    canTransfer: boolean;
}) => {
    const suggestions: {
        key: string;
        label: string;
        description: string;
        tone: Tone;
        priority: number;
        route?: string;
    }[] = [];

    if (asset.status === ASSET_STATUS.BROKEN || openMaintenanceCount > 0 || asset.status === ASSET_STATUS.MAINTENANCE) {
        suggestions.push({
            key: openMaintenanceCount > 0 ? 'maintenance_list' : 'maintenance',
            label: openMaintenanceCount > 0 ? 'Xem phiếu bảo trì đang mở' : 'Tạo phiếu bảo trì',
            description:
                openMaintenanceCount > 0
                    ? 'Kiểm tra phiếu hiện tại trước khi tạo thêm.'
                    : 'Ghi nhận lỗi, ảnh hiện trạng và phương án sửa.',
            tone: 'amber',
            priority: 100,
            route: '/maintenances',
        });
    }

    if (activeDisposalCount > 0 || [ASSET_STATUS.PENDING_DISPOSAL, ASSET_STATUS.DISPOSED].includes(asset.status)) {
        suggestions.push({
            key: 'disposal',
            label: 'Kiểm tra hồ sơ thanh lý',
            description: 'Xác minh lô thanh lý, giá trị ước tính/chốt và trạng thái rà soát.',
            tone: 'rose',
            priority: 98,
            route: '/assets/disposals',
        });
    }

    if (openTransferCount > 0) {
        suggestions.push({
            key: 'transfer_current',
            label: 'Xem lệnh điều chuyển mở',
            description: 'Tránh tạo trùng lệnh chuyển hoặc cập nhật sai vị trí.',
            tone: 'indigo',
            priority: 96,
            route: '/transfers',
        });
    } else if (canTransfer) {
        suggestions.push({
            key: 'transfer',
            label: asset.status === ASSET_STATUS.STORAGE ? 'Điều phối máy tồn kho' : 'Tạo lệnh điều chuyển',
            description: 'Dùng khi máy cần chuyển cơ sở hoặc khu vực theo quy trình.',
            tone: 'indigo',
            priority: asset.status === ASSET_STATUS.STORAGE ? 90 : 72,
            route: '/transfers',
        });
    }

    if (
        activeBorrowing ||
        asset.status === ASSET_STATUS.BORROWING ||
        asset.status === ASSET_STATUS.LOANED_OUT ||
        asset.ownershipType !== ASSET_OWNERSHIP_TYPE.OWNED
    ) {
        suggestions.push({
            key: 'borrowings',
            label:
                asset.status === ASSET_STATUS.LOANED_OUT
                    ? 'Mở lô đang cho mượn'
                    : asset.ownershipType === ASSET_OWNERSHIP_TYPE.RENTAL
                      ? 'Theo dõi máy thuê'
                      : 'Theo dõi mượn/trả',
            description:
                asset.status === ASSET_STATUS.LOANED_OUT
                    ? 'Nhận lại máy theo lô, đối chiếu hiện trạng và giữ nguyên QR chính thức.'
                    : 'Kiểm tra đối tác, hạn trả, chi phí và tình trạng tem QR.',
            tone: 'violet',
            priority: asset.status === ASSET_STATUS.LOANED_OUT ? 99 : 88,
            route: '/borrowings',
        });
    }

    if (
        ![
            ASSET_STATUS.LOANED_OUT,
            ASSET_STATUS.RETURNED_TO_PARTNER,
            ASSET_STATUS.PENDING_DISPOSAL,
            ASSET_STATUS.DISPOSED,
        ].includes(asset.status as ASSET_STATUS)
    ) {
        suggestions.push({
            key: 'quick_update',
            label: 'Cập nhật trạng thái/khu vực',
            description: 'Dùng khi thực tế khác dữ liệu hệ thống.',
            tone: 'emerald',
            priority: asset.area ? 64 : 86,
        });
    }

    suggestions.push({
        key: 'profile',
        label: 'Mở hồ sơ máy',
        description: 'Xem thông tin, QR, lịch sử và phát sinh liên quan.',
        tone: 'blue',
        priority: 50,
        route: `/assets/${asset.id}`,
    });

    return suggestions.sort((a, b) => b.priority - a.priority).slice(0, 5);
};

const compactQrScanLog = (log: any) => ({
    id: String(log._id),
    action: log.action,
    result: log.result,
    source: log.source,
    actorRole: log.actorRole,
    createdAt: toIso(log.createdAt),
});

const buildTimeline = ({
    recentMaintenances,
    recentTransfers,
    activeBorrowing,
    activeDisposalItems,
    recentScans,
}: {
    recentMaintenances: any[];
    recentTransfers: any[];
    activeBorrowing: any;
    activeDisposalItems: any[];
    recentScans: any[];
}) => {
    const rows: {
        id: string;
        type: 'maintenance' | 'transfer' | 'borrowing' | 'disposal' | 'scan';
        label: string;
        description?: string;
        status?: string;
        tone: Tone;
        at?: string;
        route?: string;
    }[] = [];

    recentMaintenances.slice(0, 3).forEach((item: any) => {
        rows.push({
            id: `maintenance-${item.id}`,
            type: 'maintenance',
            label: item.repairMode === 'external' ? 'Sửa ngoài' : 'Bảo trì',
            description: item.description,
            status: MAINTENANCE_STATUS_LABEL[item.status] || item.status,
            tone: item.status === 'completed' ? 'emerald' : 'amber',
            at: item.startDate || item.createdAt,
            route: '/maintenances',
        });
    });

    recentTransfers.slice(0, 3).forEach((item: any) => {
        rows.push({
            id: `transfer-${item.id}`,
            type: 'transfer',
            label: 'Điều chuyển',
            description: `${item.fromPlant?.name || 'Chưa rõ'} -> ${item.toPlant?.name || 'Chưa rõ'}`,
            status: TRANSFER_STATUS_LABEL[item.status] || item.status,
            tone: item.status === 'completed' ? 'emerald' : 'indigo',
            at: item.transferDate || item.createdAt,
            route: '/transfers',
        });
    });

    if (activeBorrowing?.id) {
        rows.push({
            id: `borrowing-${activeBorrowing.id}`,
            type: 'borrowing',
            label: BORROWING_TYPE_LABEL[activeBorrowing.type] || 'Mượn/trả',
            description: activeBorrowing.partnerName || activeBorrowing.borrowerName || activeBorrowing.location,
            status: 'Đang mở',
            tone: 'violet',
            at: activeBorrowing.borrowTime || activeBorrowing.createdAt,
            route: '/borrowings',
        });
    }

    activeDisposalItems.slice(0, 2).forEach((item: any) => {
        rows.push({
            id: `disposal-${item.id}`,
            type: 'disposal',
            label: 'Thanh lý',
            description: item.batch?.code || item.reason || item.note,
            status: DISPOSAL_STATUS_LABEL[item.status] || item.status,
            tone: 'rose',
            at: item.checkedAt || item.createdAt,
            route: '/assets/disposals',
        });
    });

    recentScans.slice(0, 3).forEach((log: any) => {
        rows.push({
            id: `scan-${log.id}`,
            type: 'scan',
            label: 'Quét QR',
            description: `${log.action} - ${log.result}`,
            status: log.source,
            tone: log.result === 'success' || log.result === 'resolved' ? 'blue' : 'slate',
            at: log.createdAt,
        });
    });

    return rows
        .filter((row) => row.at)
        .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())
        .slice(0, 7);
};

export const getQrFieldInsight = async (req: Request, res: Response) => {
    const assetId = String(req.params.assetId || '');
    if (!mongoose.isValidObjectId(assetId)) {
        throw new BadRequestError('ID máy không hợp lệ');
    }

    const objectId = new mongoose.Types.ObjectId(assetId);
    const assetDoc = await Asset.findOne({ _id: objectId, isDeleted: { $ne: true } })
        .populate('brandId')
        .populate('plantId')
        .populate('lastSeen.plantId')
        .populate('lastSeen.scannedBy');

    if (!assetDoc) {
        throw new NotFoundError('Không tìm thấy máy');
    }

    const [
        openMaintenanceDocs,
        recentMaintenanceDocs,
        openTransferDocs,
        recentTransferDocs,
        activeBorrowingDoc,
        disposalDocs,
        recentScanDocs,
    ] = await Promise.all([
        Maintenance.find({
            isDeleted: { $ne: true },
            ...openAssetFilter(objectId),
            status: { $nin: ['completed', 'cancelled'] },
        })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('assetId')
            .populate('assetIds')
            .populate('plantId')
            .lean(),
        Maintenance.find({
            isDeleted: { $ne: true },
            ...openAssetFilter(objectId),
        })
            .sort({ startDate: -1, createdAt: -1 })
            .limit(5)
            .populate('assetId')
            .populate('assetIds')
            .populate('plantId')
            .lean(),
        Transfer.find({
            isDeleted: { $ne: true },
            ...openAssetFilter(objectId),
            status: { $in: ['pending', 'approved'] },
        })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('assetId')
            .populate('assetIds')
            .populate('fromPlantId')
            .populate('toPlantId')
            .lean(),
        Transfer.find({
            isDeleted: { $ne: true },
            ...openAssetFilter(objectId),
        })
            .sort({ transferDate: -1, createdAt: -1 })
            .limit(5)
            .populate('assetId')
            .populate('assetIds')
            .populate('fromPlantId')
            .populate('toPlantId')
            .lean(),
        Borrowing.findOne({
            isDeleted: { $ne: true },
            assetId: objectId,
            status: 'active',
        })
            .sort({ borrowTime: -1, createdAt: -1 })
            .populate('assetId')
            .populate('batchId')
            .populate('borrowerId')
            .lean(),
        AssetDisposalItem.find({
            isDeleted: { $ne: true },
            assetId: objectId,
            status: {
                $in: [
                    ASSET_DISPOSAL_ITEM_STATUS.PENDING,
                    ASSET_DISPOSAL_ITEM_STATUS.CHECKED,
                    ASSET_DISPOSAL_ITEM_STATUS.APPROVED,
                ],
            },
        })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('assetId')
            .populate('plantId')
            .populate('batchId')
            .lean(),
        QrScanLog.find({ assetId: objectId }).sort({ createdAt: -1 }).limit(6).lean(),
    ]);

    const asset = serializeAsset(assetDoc);
    const openMaintenances = openMaintenanceDocs.map(serializeMaintenance);
    const recentMaintenances = recentMaintenanceDocs.map(serializeMaintenance);
    const openTransfers = openTransferDocs.map(serializeTransfer);
    const recentTransfers = recentTransferDocs.map(serializeTransfer);
    const activeBorrowing = activeBorrowingDoc ? serializeBorrowing(activeBorrowingDoc) : undefined;
    const activeDisposalItems = disposalDocs.map(serializeAssetDisposalItem);
    const recentScans = recentScanDocs.map(compactQrScanLog);

    const lastScanAt = asset.lastSeen?.scannedAt || recentScans[0]?.createdAt;
    const staleScanDays = daysFromNow(lastScanAt);
    const canTransfer =
        openTransfers.length === 0 &&
        ![
            ASSET_STATUS.LOANED_OUT,
            ASSET_STATUS.RETURNED_TO_PARTNER,
            ASSET_STATUS.PENDING_DISPOSAL,
            ASSET_STATUS.DISPOSED,
        ].includes(asset.status as ASSET_STATUS);

    const health = buildHealth({
        asset,
        openMaintenanceCount: openMaintenances.length,
        openTransferCount: openTransfers.length,
        activeBorrowing,
        activeDisposalCount: activeDisposalItems.length,
        staleScanDays,
    });

    const facts = [
        {
            key: 'status',
            label: 'Trạng thái',
            value: STATUS_LABEL[asset.status] || asset.status || 'Chưa rõ',
            tone:
                asset.status === ASSET_STATUS.BROKEN || asset.status === ASSET_STATUS.DISPOSED
                    ? ('rose' as Tone)
                    : asset.status === ASSET_STATUS.MAINTENANCE || asset.status === ASSET_STATUS.PENDING_DISPOSAL
                      ? ('amber' as Tone)
                      : ('blue' as Tone),
        },
        {
            key: 'location',
            label: 'Vị trí hệ thống',
            value: [asset.plant?.name, asset.area].filter(Boolean).join(' - ') || 'Chưa gắn vị trí',
            tone: asset.area ? ('emerald' as Tone) : ('amber' as Tone),
        },
        {
            key: 'maintenance',
            label: 'Bảo trì mở',
            value: `${openMaintenances.length} phiếu`,
            tone: openMaintenances.length ? ('amber' as Tone) : ('emerald' as Tone),
        },
        {
            key: 'transfer',
            label: 'Lệnh chuyển mở',
            value: `${openTransfers.length} lệnh`,
            tone: openTransfers.length ? ('indigo' as Tone) : ('emerald' as Tone),
        },
        {
            key: 'ownership',
            label: 'Nguồn máy',
            value: OWNERSHIP_LABEL[asset.ownershipType] || asset.ownershipType || 'Chưa rõ',
            tone: asset.ownershipType === ASSET_OWNERSHIP_TYPE.OWNED ? ('blue' as Tone) : ('violet' as Tone),
        },
        {
            key: 'last_scan',
            label: 'Quét gần nhất',
            value: lastScanAt
                ? typeof staleScanDays === 'number'
                    ? `${staleScanDays} ngày trước`
                    : 'Đã ghi nhận'
                : 'Chưa có log',
            tone:
                !lastScanAt || (typeof staleScanDays === 'number' && staleScanDays >= 30)
                    ? ('amber' as Tone)
                    : ('blue' as Tone),
        },
    ];

    const alerts: { severity: Severity; title: string; description: string; evidence?: string[] }[] = [];

    if (asset.status === ASSET_STATUS.BROKEN) {
        alerts.push({
            severity: 'danger',
            title: 'Máy đang hỏng/lỗi',
            description: 'Ưu tiên tạo phiếu bảo trì hoặc kiểm tra phiếu đang mở trước khi vận hành.',
            evidence: openMaintenances
                .slice(0, 2)
                .map((item) => item.description)
                .filter(Boolean) as string[],
        });
    }
    if (openTransfers.length > 0) {
        alerts.push({
            severity: 'warning',
            title: 'Có lệnh điều chuyển chưa hoàn tất',
            description: 'Không nên tạo lệnh điều chuyển trùng nếu chưa xác nhận lệnh hiện tại.',
            evidence: openTransfers
                .slice(0, 2)
                .map(
                    (item) =>
                        `${item.fromPlant?.name || 'Nguồn'} -> ${item.toPlant?.name || 'Đích'} (${TRANSFER_STATUS_LABEL[item.status] || item.status})`
                ),
        });
    }
    if (activeDisposalItems.length > 0 || asset.status === ASSET_STATUS.PENDING_DISPOSAL) {
        alerts.push({
            severity: 'danger',
            title: 'Máy nằm trong danh sách rà soát/thanh lý',
            description: 'Cần kiểm tra module thanh lý trước khi cập nhật trạng thái vận hành.',
            evidence: activeDisposalItems
                .slice(0, 2)
                .map(
                    (item) =>
                        `${item.batch?.code || 'Lô thanh lý'} - ${DISPOSAL_STATUS_LABEL[item.status] || item.status}`
                ),
        });
    }
    if (asset.locationMismatch?.mismatch) {
        alerts.push({
            severity: 'warning',
            title: 'Có dấu hiệu lệch vị trí GPS',
            description: `Hệ thống ghi ${asset.locationMismatch.officialPlantName || 'chưa rõ'}, lần quét gần nhất ở ${
                asset.locationMismatch.actualPlantName || 'cơ sở khác'
            }.`,
        });
    }
    if (!asset.area?.trim()) {
        alerts.push({
            severity: 'warning',
            title: 'Chưa có khu vực chi tiết',
            description: 'Nên cập nhật khu vực để phục vụ kiểm kê QR và truy vết máy tại xưởng.',
        });
    }
    if (typeof staleScanDays === 'number' && staleScanDays >= 30) {
        alerts.push({
            severity: 'info',
            title: 'Lâu chưa xác nhận bằng QR',
            description: `Lần quét gần nhất cách ${staleScanDays} ngày. Nên quét/cập nhật lại nếu máy vừa di chuyển.`,
        });
    }

    const data = {
        generatedAt: new Date().toISOString(),
        asset,
        health,
        facts,
        alerts,
        suggestions: buildSuggestions({
            asset,
            openMaintenanceCount: openMaintenances.length,
            openTransferCount: openTransfers.length,
            activeBorrowing,
            activeDisposalCount: activeDisposalItems.length,
            canTransfer,
        }),
        related: {
            openMaintenances,
            recentMaintenances: recentMaintenances.slice(0, 5),
            openTransfers,
            recentTransfers: recentTransfers.slice(0, 5),
            activeBorrowing,
            activeDisposalItems,
            recentScans,
        },
        timeline: buildTimeline({
            recentMaintenances,
            recentTransfers,
            activeBorrowing,
            activeDisposalItems,
            recentScans,
        }),
        counters: {
            openMaintenanceCount: openMaintenances.length,
            openTransferCount: openTransfers.length,
            activeDisposalCount: activeDisposalItems.length,
            hasActiveBorrowing: Boolean(activeBorrowing),
        },
    };

    return res.status(StatusCodes.OK).json(
        customResponse({
            data,
            message: 'Đã tạo QR field insight',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
