import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionLineRecord from '@/models/ProductionLineRecord';
import ProductionOrder from '@/models/ProductionOrder';
import ProductionPlan from '@/models/ProductionPlan';
import { vietnamIsoDate } from '@/utils/vietnamDate';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { addCapacityDays } from './production-capacity.helpers';
import { buildControlTowerOrder, summarizeControlTower } from './production-control-tower.helpers';
import { loadReadinessRows } from './production-material.service';
import { buildProductionOrderProgress, synchronizeProductionOrderLifecycle } from './production-order.service';
import { sendSuccess } from './service.helpers';

const OPEN_STATUSES = ['draft', 'ready', 'in_production', 'paused'];
const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const assertPlantAccess = (req: Request, plantId: string) => {
    if ([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE)) return;
    if (!plantId || userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền xem Control Tower của cơ sở này');
    }
};

const resolvePlant = async (req: Request, input: unknown) => {
    const id = String(input || userPlantId(req) || '');
    if (!id || !mongoose.isValidObjectId(id)) throw new BadRequestError('Cần chọn cơ sở hợp lệ');
    assertPlantAccess(req, id);
    const plant: any = await Plant.findOne({ _id: id, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: String(plant._id), name: plant.name, code: plant.code || '' };
};

const toOrderReference = (source: any, byId: Map<string, string>, byCode: Map<string, string>) =>
    (source.orderId ? byId.get(String(source.orderId)) : undefined) ||
    byCode.get(
        String(source.orderCode || '')
            .trim()
            .toUpperCase()
    );

export const loadControlTower = async (req: Request, inputPlantId: unknown, windowDaysInput: unknown) => {
    const plant = await resolvePlant(req, inputPlantId);
    const today = vietnamIsoDate();
    const windowDays = Math.min(90, Math.max(7, Number(windowDaysInput) || 30));
    const historyStart = addCapacityDays(today, -30);
    const horizonEnd = addCapacityDays(today, windowDays);
    const orders: any[] = await ProductionOrder.find({
        plantId: plant.id,
        status: { $in: [...OPEN_STATUSES, 'completed'] },
        $or: [
            { status: { $in: OPEN_STATUSES } },
            { status: 'completed', updatedAt: { $gte: new Date(`${historyStart}T00:00:00.000Z`) } },
        ],
    })
        .sort({ dueDate: 1, priority: -1, code: 1 })
        .limit(500)
        .lean();
    if (!orders.length) {
        return {
            plant,
            range: { today, historyStart, horizonEnd, windowDays },
            summary: summarizeControlTower([], today),
            orders: [],
            exceptions: [],
            generatedAt: new Date().toISOString(),
        };
    }

    const ids = orders.map((order) => String(order._id));
    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    const codes = orders.map((order) => String(order.code).trim().toUpperCase());
    const byId = new Map(ids.map((id) => [id, id]));
    const byCode = new Map(orders.map((order) => [String(order.code).trim().toUpperCase(), String(order._id)]));
    const [progressByOrder, readinessRows, records, plans]: [
        Awaited<ReturnType<typeof buildProductionOrderProgress>>,
        any[],
        any[],
        any[],
    ] = await Promise.all([
        buildProductionOrderProgress(plant.id, orders),
        loadReadinessRows(plant.id, ids),
        ProductionLineRecord.find({
            plantId: plant.id,
            productionDate: { $gte: historyStart, $lte: today },
            $or: [{ 'runs.orderId': { $in: objectIds } }, { 'runs.orderCode': { $in: codes } }],
        })
            .select('productionDate runs entries')
            .lean(),
        ProductionPlan.find({
            plantId: plant.id,
            productionDate: { $gte: historyStart, $lte: horizonEnd },
            $or: [{ 'allocations.orderId': { $in: objectIds } }, { 'allocations.orderCode': { $in: codes } }],
        })
            .select('productionDate status allocations')
            .lean(),
    ]);

    const actualByOrderDate = new Map<string, Map<string, number>>();
    records.forEach((record) => {
        const orderByRun = new Map<string, string>();
        (record.runs || []).forEach((run: any) => {
            const orderId = toOrderReference(run, byId, byCode);
            if (orderId) orderByRun.set(String(run._id), orderId);
        });
        (record.entries || []).forEach((entry: any) => {
            const orderId = orderByRun.get(String(entry.runId));
            if (!orderId) return;
            const daily = actualByOrderDate.get(orderId) || new Map<string, number>();
            daily.set(
                String(record.productionDate),
                Number(daily.get(String(record.productionDate)) || 0) + Number(entry.quantity || 0)
            );
            actualByOrderDate.set(orderId, daily);
        });
    });

    const planByOrderDateStatus = new Map<string, Map<string, number>>();
    plans.forEach((plan) => {
        (plan.allocations || []).forEach((allocation: any) => {
            const orderId = toOrderReference(allocation, byId, byCode);
            if (!orderId) return;
            const key = `${plan.productionDate}|${plan.status}`;
            const grouped = planByOrderDateStatus.get(orderId) || new Map<string, number>();
            grouped.set(key, Number(grouped.get(key) || 0) + Number(allocation.plannedQuantity || 0));
            planByOrderDateStatus.set(orderId, grouped);
        });
    });

    const readinessByOrder = new Map(readinessRows.map((row) => [String(row.order.id), row]));
    const rows = orders
        .map((order) => {
            const id = String(order._id);
            const progress = progressByOrder.get(id);
            if (!progress) return undefined;
            const readiness = readinessByOrder.get(id);
            const dailyActual = [...(actualByOrderDate.get(id) || new Map()).entries()].map(([date, quantity]) => ({
                date,
                quantity,
            }));
            const orderPlans = [...(planByOrderDateStatus.get(id) || new Map()).entries()].map(([key, quantity]) => {
                const [date, status] = key.split('|');
                return { date, quantity, status: status as 'draft' | 'published' };
            });
            return buildControlTowerOrder({
                order: {
                    id,
                    code: order.code,
                    itemId: String(order.itemId),
                    itemCode: order.itemCode,
                    itemName: order.itemName,
                    customerName: order.customerName,
                    totalQuantity: Number(order.totalQuantity || 0),
                    dueDate: order.dueDate,
                    plannedStartDate: order.plannedStartDate,
                    priority: order.priority,
                    status: order.status,
                },
                progress,
                material: readiness
                    ? {
                          status: readiness.status,
                          reservationStatus: readiness.reservationStatus,
                          shortageLineCount: readiness.summary?.shortageLineCount || 0,
                          materialReadyDate: readiness.materialReadyDate,
                      }
                    : undefined,
                dailyActual,
                plans: orderPlans,
                today,
            });
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .sort(
            (left, right) =>
                Number(right.severity === 'critical') - Number(left.severity === 'critical') ||
                left.dueDate.localeCompare(right.dueDate) ||
                left.code.localeCompare(right.code)
        );
    const exceptions = rows.flatMap((order) =>
        order.exceptions.map((exception) => ({
            ...exception,
            orderId: order.id,
            orderCode: order.code,
            dueDate: order.dueDate,
        }))
    );
    return {
        plant,
        range: { today, historyStart, horizonEnd, windowDays },
        summary: summarizeControlTower(rows, today),
        orders: rows,
        exceptions,
        generatedAt: new Date().toISOString(),
    };
};

export const getProductionControlTower = async (req: Request, res: Response) => {
    const report = await loadControlTower(req, req.query.plantId, req.query.windowDays);
    return sendSuccess(res, report, 'Đã tải trung tâm điều hành kế hoạch - thực tế');
};

export const syncProductionControlTowerStatuses = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.body.plantId);
    const orderIds = Array.isArray(req.body.orderIds) ? req.body.orderIds.map(String) : [];
    const openOrders = await ProductionOrder.find({
        plantId: plant.id,
        status: { $in: [...OPEN_STATUSES, 'completed'] },
        ...(orderIds.length ? { _id: { $in: orderIds } } : {}),
    })
        .select('_id code')
        .lean();
    const changes = await synchronizeProductionOrderLifecycle({
        plantId: plant.id,
        actorId: String(req.userId),
        orderIds: openOrders.map((order) => String(order._id)),
    });
    return sendSuccess(
        res,
        { synchronizedCount: changes.length, changes },
        changes.length ? `Đã đồng bộ trạng thái ${changes.length} đơn hàng` : 'Trạng thái đơn hàng đã khớp số thực tế'
    );
};
