import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import { sendSuccess } from '@/services/service.helpers';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

const GLOBAL_PRODUCTION_ROLES = new Set<string>([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR]);

const toId = (value: any): string => String(value?._id ?? value ?? '');

export const hasGlobalProductionAccess = (role?: string) => Boolean(role && GLOBAL_PRODUCTION_ROLES.has(role));

export const isProductionEnabled = (plant: any) => plant?.productionAccess?.enabled === true;

export const evaluateProductionAccess = ({
    role,
    userPlantId,
    targetPlantId,
    enabled,
}: {
    role?: string;
    userPlantId?: string;
    targetPlantId: string;
    enabled: boolean;
}) => {
    const globalAccess = hasGlobalProductionAccess(role);
    const inPlantScope = globalAccess || Boolean(userPlantId && userPlantId === targetPlantId);
    const canAccess = inPlantScope && (globalAccess || enabled);

    return {
        globalAccess,
        inPlantScope,
        enabled,
        canAccess,
        reason: !inPlantScope ? 'PLANT_SCOPE_DENIED' : canAccess ? undefined : 'PRODUCTION_NOT_ENABLED',
    } as const;
};

const getUserPlantId = (req: Request) => toId(req.user?.plantId);

const resolveRequestedPlantId = (req: Request, input?: unknown) => {
    const plantId = String(
        input || getUserPlantId(req) || (hasGlobalProductionAccess(req.role) ? process.env.MAIN_PLANT_ID : '') || ''
    );
    if (!mongoose.isValidObjectId(plantId)) {
        throw new BadRequestError('Cơ sở không hợp lệ');
    }
    const decision = evaluateProductionAccess({
        role: req.role,
        userPlantId: getUserPlantId(req),
        targetPlantId: plantId,
        enabled: true,
    });
    if (!decision.inPlantScope) {
        throw new UnAuthorizedError('Bạn chỉ được sử dụng phân hệ Sản xuất tại cơ sở được phân công');
    }
    return plantId;
};

const loadProductionPlant = async (plantId: string) => {
    const plant: any = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } })
        .select('name code productionAccess')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return plant;
};

/**
 * Backfill một lần cho dữ liệu cũ. MAIN_PLANT_ID hiện là CS1; chỉ bản ghi chưa từng
 * được cấu hình mới bị tác động nên các lần khởi động sau không bật lại cơ sở đã tắt.
 */
export const ensureProductionAccessDefaults = async () => {
    const mainPlantId = String(process.env.MAIN_PLANT_ID || '');
    let enabledMainPlant = 0;

    if (mongoose.isValidObjectId(mainPlantId)) {
        const result = await Plant.updateOne(
            {
                _id: mainPlantId,
                isDeleted: { $ne: true },
                'productionAccess.enabled': { $exists: false },
            },
            {
                $set: {
                    'productionAccess.enabled': true,
                    'productionAccess.enabledAt': new Date(),
                },
            }
        );
        enabledMainPlant = result.modifiedCount;
    } else {
        console.warn('[ProductionAccess] MAIN_PLANT_ID is missing or invalid; no legacy plant was auto-enabled.');
    }

    const disabledResult = await Plant.updateMany(
        {
            isDeleted: { $ne: true },
            'productionAccess.enabled': { $exists: false },
        },
        { $set: { 'productionAccess.enabled': false } }
    );

    if (enabledMainPlant || disabledResult.modifiedCount) {
        console.log(
            `[ProductionAccess] Backfilled CS1=${enabledMainPlant}, disabled=${disabledResult.modifiedCount} legacy plant(s).`
        );
    }
};

/** Chặn riêng toàn bộ API /production của cơ sở chưa triển khai. */
export const requireProductionEnabled = async (req: Request, _res: Response, next: NextFunction) => {
    try {
        if (hasGlobalProductionAccess(req.role)) return next();

        const plantId = resolveRequestedPlantId(req);
        const plant = await loadProductionPlant(plantId);
        const decision = evaluateProductionAccess({
            role: req.role,
            userPlantId: getUserPlantId(req),
            targetPlantId: plantId,
            enabled: isProductionEnabled(plant),
        });
        if (!decision.canAccess) {
            return next(new UnAuthorizedError('Phân hệ Sản xuất chưa được triển khai tại cơ sở của bạn'));
        }
        return next();
    } catch (error) {
        return next(error);
    }
};

/** Endpoint nhẹ để FE hiển thị đúng trạng thái thay vì chỉ dựa vào việc ẩn menu. */
export const getProductionAccess = async (req: Request, res: Response) => {
    const plantId = resolveRequestedPlantId(req, req.query.plantId);
    const plant = await loadProductionPlant(plantId);
    const enabled = isProductionEnabled(plant);
    const decision = evaluateProductionAccess({
        role: req.role,
        userPlantId: getUserPlantId(req),
        targetPlantId: plantId,
        enabled,
    });

    return sendSuccess(
        res,
        {
            plantId,
            plantName: String(plant.name || ''),
            plantCode: String(plant.code || ''),
            enabled,
            globalAccess: decision.globalAccess,
            canAccess: decision.canAccess,
            reason: decision.reason,
        },
        'Đã kiểm tra quyền truy cập phân hệ Sản xuất'
    );
};
