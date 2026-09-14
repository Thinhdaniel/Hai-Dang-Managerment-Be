import { BadRequestError, NotFoundError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionBom from '@/models/ProductionBom';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionOrder from '@/models/ProductionOrder';
import ProductionPilotRun from '@/models/ProductionPilotRun';
import ProductionPlan from '@/models/ProductionPlan';
import ProductionScheduleTemplate from '@/models/ProductionScheduleTemplate';
import User from '@/models/User';
import { addVietnamDays, vietnamIsoDate } from '@/utils/vietnamDate';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
    buildProductionRolloutReadiness,
    evaluateProductionRolloutTransition,
    normalizeProductionRolloutStage,
    type ProductionRolloutReadinessInput,
    type ProductionRolloutStage,
} from './production-rollout.helpers';
import { sendSuccess } from './service.helpers';

const OPEN_ORDER_STATUSES = ['ready', 'in_production', 'paused'];
const ACTIVE_USER_FILTER = { isDeleted: { $ne: true }, isActive: { $ne: false }, status: { $ne: false } };

const toId = (value: any) => String(value?._id ?? value ?? '');
const actorName = (req: Request) => String(req.user?.fullname || req.user?.name || req.user?.email || 'Người dùng');

const groupedCounts = async (model: any, match: Record<string, unknown>): Promise<Map<string, number>> => {
    const rows = await model.aggregate([{ $match: match }, { $group: { _id: '$plantId', count: { $sum: 1 } } }]);
    return new Map<string, number>(rows.map((row: any) => [String(row._id), Number(row.count || 0)]));
};

const loadReadinessData = async () => {
    const today = vietnamIsoDate();
    const horizon = vietnamIsoDate(addVietnamDays(new Date(), 14));
    const [lines, items, schedules, managers, leaders, qcUsers, orders, boms, plans, acceptedPilots, lastRecords] =
        await Promise.all([
            groupedCounts(ProductionLine, { isActive: true }),
            groupedCounts(ProductionItem, { isActive: true }),
            groupedCounts(ProductionScheduleTemplate, {
                isWorkingDay: true,
                weekday: { $in: [1, 2, 3, 4, 5, 6] },
                'timeSlots.0': { $exists: true },
            }),
            groupedCounts(User, { ...ACTIVE_USER_FILTER, role: 'manager' }),
            groupedCounts(User, { ...ACTIVE_USER_FILTER, role: 'line_leader' }),
            groupedCounts(User, { ...ACTIVE_USER_FILTER, role: 'qc' }),
            groupedCounts(ProductionOrder, { status: { $in: OPEN_ORDER_STATUSES } }),
            groupedCounts(ProductionBom, { status: 'approved' }),
            groupedCounts(ProductionPlan, {
                status: 'published',
                productionDate: { $gte: today, $lte: horizon },
                'allocations.0': { $exists: true },
            }),
            ProductionPilotRun.aggregate([
                { $match: { status: 'accepted' } },
                { $sort: { 'signoff.signedAt': -1, updatedAt: -1 } },
                { $group: { _id: '$plantId', run: { $first: '$$ROOT' } } },
                { $project: { _id: 1, runId: '$run._id', code: '$run.code', signedAt: '$run.signoff.signedAt' } },
            ]),
            ProductionLineRecord.aggregate([
                { $sort: { productionDate: -1 } },
                { $group: { _id: '$plantId', productionDate: { $first: '$productionDate' } } },
            ]),
        ]);

    return {
        counts: { lines, items, schedules, managers, leaders, qcUsers, orders, boms, plans },
        acceptedPilots: new Map(acceptedPilots.map((row: any) => [String(row._id), row])),
        lastRecords: new Map(lastRecords.map((row: any) => [String(row._id), row.productionDate])),
    };
};

const serializeHistory = (history: any[] = []) =>
    [...history]
        .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
        .slice(0, 20)
        .map((entry) => ({
            id: toId(entry),
            fromStage: entry.fromStage,
            toStage: entry.toStage,
            reason: entry.reason,
            actorId: toId(entry.actorId),
            actorName: entry.actorName,
            at: entry.at ? new Date(entry.at).toISOString() : undefined,
        }));

const buildPlantRow = (plant: any, data: Awaited<ReturnType<typeof loadReadinessData>>) => {
    const id = toId(plant);
    const pilot: any = data.acceptedPilots.get(id);
    const count = (key: keyof typeof data.counts) => data.counts[key].get(id) || 0;
    const input: ProductionRolloutReadinessInput = {
        activeLines: count('lines'),
        activeItems: count('items'),
        configuredScheduleDays: count('schedules'),
        localManagers: count('managers'),
        lineLeaders: count('leaders'),
        qcUsers: count('qcUsers'),
        openOrders: count('orders'),
        approvedBoms: count('boms'),
        publishedPlanDays: count('plans'),
        acceptedPilotCode: pilot?.code,
    };
    const access = plant.productionAccess || {};
    return {
        plant: { id, name: plant.name, code: plant.code },
        stage: normalizeProductionRolloutStage(access),
        enabled: access.enabled === true,
        revision: Number(access.revision || 0),
        wave: access.wave,
        plannedGoLiveDate: access.plannedGoLiveDate,
        ownerName: access.ownerName,
        previousStage: access.previousStage,
        acceptedPilotRun: pilot
            ? {
                  id: String(pilot.runId),
                  code: pilot.code,
                  signedAt: pilot.signedAt ? new Date(pilot.signedAt).toISOString() : undefined,
              }
            : undefined,
        lastProductionDate: data.lastRecords.get(id),
        lastTransitionAt: access.lastTransitionAt ? new Date(access.lastTransitionAt).toISOString() : undefined,
        lastTransitionByName: access.lastTransitionByName,
        lastTransitionReason: access.lastTransitionReason,
        readiness: buildProductionRolloutReadiness(input),
        history: serializeHistory(access.history),
    };
};

const loadPortfolio = async () => {
    const [plants, readinessData] = await Promise.all([
        Plant.find({ isDeleted: { $ne: true } })
            .select('name code productionAccess')
            .sort({ code: 1 })
            .lean(),
        loadReadinessData(),
    ]);
    const facilities = plants.map((plant) => buildPlantRow(plant, readinessData));
    const byStage = facilities.reduce<Record<ProductionRolloutStage, number>>(
        (summary, facility) => {
            summary[facility.stage] += 1;
            return summary;
        },
        { disabled: 0, preparing: 0, pilot: 0, live: 0, paused: 0 }
    );
    return {
        generatedAt: new Date().toISOString(),
        summary: {
            totalPlants: facilities.length,
            byStage,
            pilotReady: facilities.filter((facility) => facility.readiness.pilotReady).length,
            liveReady: facilities.filter((facility) => facility.readiness.liveReady).length,
            enabledPlants: facilities.filter((facility) => facility.enabled).length,
        },
        facilities,
    };
};

export const getProductionRolloutPortfolio = async (_req: Request, res: Response) => {
    return sendSuccess(res, await loadPortfolio(), 'Đã tải trung tâm triển khai Sản xuất');
};

export const transitionProductionRollout = async (req: Request, res: Response) => {
    const plantId = String(req.params.plantId || '');
    if (!mongoose.isValidObjectId(plantId)) throw new BadRequestError('Cơ sở không hợp lệ');

    const portfolio = await loadPortfolio();
    const current = portfolio.facilities.find((facility) => facility.plant.id === plantId);
    if (!current) throw new NotFoundError('Không tìm thấy cơ sở');
    if (Number(req.body.revision) !== current.revision) {
        throw new BadRequestError('Trạng thái triển khai đã thay đổi. Hãy tải lại dữ liệu trước khi thao tác.');
    }

    const toStage = req.body.toStage as ProductionRolloutStage;
    const decision = evaluateProductionRolloutTransition({
        fromStage: current.stage,
        toStage,
        readiness: current.readiness,
    });
    if (!decision.allowed) {
        const details = decision.blockers.length ? ` Thiếu: ${decision.blockers.join(', ')}.` : '';
        throw new BadRequestError(`Không thể chuyển từ ${current.stage} sang ${toStage}.${details}`);
    }

    const now = new Date();
    const enabled = toStage === 'pilot' || toStage === 'live';
    const latestPilot = current.acceptedPilotRun;
    const set: Record<string, unknown> = {
        'productionAccess.stage': toStage,
        'productionAccess.enabled': enabled,
        'productionAccess.lastTransitionAt': now,
        'productionAccess.lastTransitionBy': req.userId,
        'productionAccess.lastTransitionByName': actorName(req),
        'productionAccess.lastTransitionReason': req.body.reason,
        ...(req.body.wave !== undefined ? { 'productionAccess.wave': req.body.wave } : {}),
        ...(req.body.plannedGoLiveDate !== undefined
            ? { 'productionAccess.plannedGoLiveDate': req.body.plannedGoLiveDate || null }
            : {}),
        ...(req.body.ownerName !== undefined ? { 'productionAccess.ownerName': req.body.ownerName || null } : {}),
    };
    if (toStage === 'paused') set['productionAccess.previousStage'] = current.stage;
    if (enabled) {
        set['productionAccess.enabledAt'] = now;
        set['productionAccess.enabledBy'] = req.userId;
        set['productionAccess.disabledAt'] = null;
        set['productionAccess.disabledBy'] = null;
    } else {
        set['productionAccess.disabledAt'] = now;
        set['productionAccess.disabledBy'] = req.userId;
    }
    if (toStage === 'live' && latestPilot) {
        set['productionAccess.acceptedPilotRunId'] = latestPilot.id;
        set['productionAccess.acceptedPilotCode'] = latestPilot.code;
    }

    const revisionFilter =
        current.revision === 0
            ? { $or: [{ 'productionAccess.revision': 0 }, { 'productionAccess.revision': { $exists: false } }] }
            : { 'productionAccess.revision': current.revision };
    const updated: any = await Plant.findOneAndUpdate(
        { _id: plantId, isDeleted: { $ne: true }, ...revisionFilter },
        {
            $set: set,
            $inc: { 'productionAccess.revision': 1 },
            $push: {
                'productionAccess.history': {
                    $each: [
                        {
                            fromStage: current.stage,
                            toStage,
                            reason: req.body.reason,
                            actorId: req.userId,
                            actorName: actorName(req),
                            at: now,
                        },
                    ],
                    $slice: -100,
                },
            },
        },
        { returnDocument: 'after' }
    ).lean();
    if (!updated) throw new BadRequestError('Trạng thái đã thay đổi đồng thời. Hãy tải lại và thử lại.');

    const refreshedData = await loadReadinessData();
    return sendSuccess(res, buildPlantRow(updated, refreshedData), 'Đã cập nhật giai đoạn triển khai');
};
