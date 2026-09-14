import { USER_ROLE } from '@/constant/allowedRoles';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import Plant from '@/models/Plant';
import ProductionItem from '@/models/ProductionItem';
import ProductionLine from '@/models/ProductionLine';
import ProductionOrder from '@/models/ProductionOrder';
import ProductionPlan from '@/models/ProductionPlan';
import ProductionScheduleTemplate from '@/models/ProductionScheduleTemplate';
import { vietnamIsoDate } from '@/utils/vietnamDate';
import type { Request, Response } from 'express';
import {
    addCapacityDays,
    buildCapacityDates,
    capacityMinutesForAllocation,
    capacityMonday,
    consumeCapacityForQuantity,
    isValidCapacityDate,
    medianCapacityRate,
    type CapacityBucket,
    type CapacitySlot,
} from './production-capacity.helpers';
import { buildProductionOrderProgress } from './production-order.service';
import { loadReadinessRows } from './production-material.service';
import {
    defaultProductionScheduleForWeekday,
    normalizeProductionTimeSlots,
    productionWeekdayFromDate,
} from './production-schedule.helpers';
import { sendSuccess } from './service.helpers';

const OPEN_ORDER_STATUSES = ['draft', 'ready', 'in_production', 'paused'];
const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

const userPlantId = (req: Request) => String(req.user?.plantId?._id ?? req.user?.plantId ?? '');

const resolvePlant = async (req: Request, input: unknown) => {
    const plantId = String(input || userPlantId(req) || '');
    if (!plantId) throw new BadRequestError('Cần chọn cơ sở');
    if (![USER_ROLE.ADMIN, USER_ROLE.DIRECTOR].includes(req.role as USER_ROLE) && userPlantId(req) !== plantId) {
        throw new UnAuthorizedError('Bạn không có quyền xem năng lực của cơ sở này');
    }
    const plant: any = await Plant.findOne({ _id: plantId, isDeleted: { $ne: true } })
        .select('name code')
        .lean();
    if (!plant) throw new NotFoundError('Không tìm thấy cơ sở');
    return { id: String(plant._id), name: plant.name, code: plant.code || '' };
};

const maxDate = (...values: Array<string | undefined>) => values.filter(Boolean).sort().at(-1) as string | undefined;
const minDate = (...values: Array<string | undefined>) => values.filter(Boolean).sort().at(0) as string | undefined;

const riskMeta = ({
    dueDate,
    today,
    projectedCompletionDate,
    unallocatedQuantity,
    uncoveredByDue,
    hourlyRate,
    remainingQuantity,
}: {
    dueDate: string;
    today: string;
    projectedCompletionDate?: string;
    unallocatedQuantity: number;
    uncoveredByDue: number;
    hourlyRate: number;
    remainingQuantity: number;
}) => {
    if (remainingQuantity <= 0) {
        return {
            code: 'completed',
            severity: 0,
            label: 'Đã đủ sản lượng',
            recommendation: 'Đóng đơn hàng sau đối soát.',
        };
    }
    if (dueDate < today) {
        return {
            code: 'overdue',
            severity: 5,
            label: 'Đã quá hạn',
            recommendation: 'Ưu tiên xử lý và xác nhận lại cam kết giao.',
        };
    }
    if (!hourlyRate && uncoveredByDue > 0) {
        return {
            code: 'data_gap',
            severity: 4,
            label: 'Thiếu năng suất chuẩn',
            recommendation: 'Khai báo năng suất chuẩn của mã hàng để dự báo.',
        };
    }
    if (unallocatedQuantity > 0) {
        return {
            code: 'capacity_shortfall',
            severity: 5,
            label: 'Thiếu năng lực trong kỳ',
            recommendation: 'Bổ sung tăng ca, chuyền hoặc điều chỉnh cam kết giao.',
        };
    }
    if (projectedCompletionDate && projectedCompletionDate > dueDate) {
        return {
            code: 'late',
            severity: 5,
            label: 'Dự kiến trễ hạn',
            recommendation: 'Đưa đơn lên trước hoặc bổ sung năng lực.',
        };
    }
    if (uncoveredByDue > 0) {
        return {
            code: 'needs_scheduling',
            severity: 3,
            label: 'Chưa xếp đủ trước hạn',
            recommendation: 'Chốt phân bổ còn thiếu vào kế hoạch ngày.',
        };
    }
    return {
        code: 'covered',
        severity: 1,
        label: 'Đã phủ kế hoạch',
        recommendation: 'Theo dõi nhịp thực tế theo ngày.',
    };
};

export const getProductionCapacity = async (req: Request, res: Response) => {
    const plant = await resolvePlant(req, req.query.plantId);
    const today = vietnamIsoDate();
    const requestedStart = String(req.query.startDate || today);
    if (!isValidCapacityDate(requestedStart)) throw new BadRequestError('Ngày bắt đầu không hợp lệ');
    const weeks = Number(req.query.weeks || 2);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) {
        throw new BadRequestError('Phạm vi năng lực phải từ 1 đến 8 tuần');
    }
    const startDate = capacityMonday(requestedStart);
    const dates = buildCapacityDates(startDate, weeks);
    const endDate = dates.at(-1)!;
    const historyStart = minDate(addCapacityDays(startDate, -90), today)!;

    const [lines, templates, plans, orders, items]: [any[], any[], any[], any[], any[]] = await Promise.all([
        ProductionLine.find({ plantId: plant.id, isActive: true }).sort({ sortOrder: 1, code: 1 }).lean(),
        ProductionScheduleTemplate.find({ plantId: plant.id }).lean(),
        ProductionPlan.find({ plantId: plant.id, productionDate: { $gte: historyStart, $lte: endDate } })
            .select('productionDate status timeSlots allocations revision')
            .lean(),
        ProductionOrder.find({ plantId: plant.id, status: { $in: OPEN_ORDER_STATUSES } })
            .sort({ dueDate: 1, priority: -1 })
            .lean(),
        ProductionItem.find({ plantId: plant.id, isActive: true }).select('code name planningHourlyQuota').lean(),
    ]);

    const templateByWeekday = new Map(templates.map((template) => [Number(template.weekday), template]));
    const planByDate = new Map(plans.map((plan) => [String(plan.productionDate), plan]));
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const lineById = new Map(lines.map((line) => [String(line._id), line]));
    const itemRateSamples = new Map<string, number[]>();
    plans.forEach((plan) => {
        (plan.allocations || []).forEach((allocation: any) => {
            const itemId = String(allocation.itemId || '');
            const rate = Number(allocation.hourlyQuota || 0);
            if (!itemId || rate <= 0) return;
            const samples = itemRateSamples.get(itemId) || [];
            samples.push(rate);
            itemRateSamples.set(itemId, samples);
        });
    });

    const slotsForDate = (date: string): CapacitySlot[] => {
        const plan = planByDate.get(date);
        if (plan?.timeSlots?.length) return normalizeProductionTimeSlots(plan.timeSlots) as CapacitySlot[];
        const weekday = productionWeekdayFromDate(date);
        const template = templateByWeekday.get(weekday);
        if (template?.timeSlots?.length) {
            const slots = normalizeProductionTimeSlots(template.timeSlots) as CapacitySlot[];
            return template.isWorkingDay === false ? slots.map((slot) => ({ ...slot, isActive: false })) : slots;
        }
        return defaultProductionScheduleForWeekday(weekday).timeSlots as CapacitySlot[];
    };

    const cellByKey = new Map<string, any>();
    const dayRows: any[] = [];
    const capacityBuckets: CapacityBucket[] = [];
    dates.forEach((date) => {
        const plan = planByDate.get(date);
        const slots = slotsForDate(date);
        const regularMinutesPerLine = slots
            .filter((slot) => slot.isActive && slot.kind === 'regular')
            .reduce((sum, slot) => sum + Math.max(0, slot.endMinute - slot.startMinute), 0);
        const availableOvertimeMinutesPerLine = slots
            .filter((slot) => slot.isActive && slot.kind === 'overtime')
            .reduce((sum, slot) => sum + Math.max(0, slot.endMinute - slot.startMinute), 0);
        lines.forEach((line) => {
            cellByKey.set(`${line._id}|${date}`, {
                date,
                lineId: String(line._id),
                lineCode: line.code,
                regularCapacityMinutes: regularMinutesPerLine,
                availableOvertimeMinutes: availableOvertimeMinutesPerLine,
                plannedRegularMinutes: 0,
                plannedOvertimeMinutes: 0,
                plannedQuantity: 0,
                nominalQuantityCapacity: 0,
                overloadQuantity: 0,
                allocations: [],
                planStatus: plan?.status,
            });
        });
        dayRows.push({
            date,
            weekday: productionWeekdayFromDate(date),
            isWorkingDay: regularMinutesPerLine > 0,
            planStatus: plan?.status,
            planRevision: Number(plan?.revision || 0),
            regularMinutesPerLine,
            availableOvertimeMinutesPerLine,
        });
    });

    plans
        .filter((plan) => String(plan.productionDate) >= startDate)
        .forEach((plan) => {
            const date = String(plan.productionDate);
            const slots = slotsForDate(date);
            (plan.allocations || []).forEach((allocation: any) => {
                const cell = cellByKey.get(`${allocation.lineId}|${date}`);
                if (!cell) return;
                const minutes = capacityMinutesForAllocation(slots, allocation.startSlotKey, allocation.endSlotKey);
                const duration = minutes.regularMinutes + minutes.overtimeMinutes;
                const nominal = (duration * Number(allocation.hourlyQuota || 0)) / 60;
                const overload = Math.max(0, Number(allocation.plannedQuantity || 0) - nominal);
                cell.plannedRegularMinutes += minutes.regularMinutes;
                cell.plannedOvertimeMinutes += minutes.overtimeMinutes;
                cell.plannedQuantity += Number(allocation.plannedQuantity || 0);
                cell.nominalQuantityCapacity += nominal;
                cell.overloadQuantity += overload;
                cell.allocations.push({
                    id: String(allocation._id),
                    orderId: allocation.orderId ? String(allocation.orderId) : undefined,
                    orderCode: allocation.orderCode,
                    itemId: String(allocation.itemId),
                    itemCode: allocation.itemCode,
                    plannedQuantity: Number(allocation.plannedQuantity || 0),
                    hourlyQuota: Number(allocation.hourlyQuota || 0),
                    regularMinutes: minutes.regularMinutes,
                    overtimeMinutes: minutes.overtimeMinutes,
                    validWindow: minutes.valid,
                });
            });
        });

    const lineRows = lines.map((line) => {
        const cells = dates.map((date) => {
            const cell = cellByKey.get(`${line._id}|${date}`);
            const freeRegularMinutes = Math.max(0, cell.regularCapacityMinutes - cell.plannedRegularMinutes);
            const utilizationPercent = cell.regularCapacityMinutes
                ? Number(((cell.plannedRegularMinutes / cell.regularCapacityMinutes) * 100).toFixed(1))
                : cell.plannedRegularMinutes > 0
                  ? 100
                  : 0;
            const outputLoadPercent = cell.nominalQuantityCapacity
                ? Number(((cell.plannedQuantity / cell.nominalQuantityCapacity) * 100).toFixed(1))
                : cell.plannedQuantity > 0
                  ? 100
                  : 0;
            const status =
                cell.overloadQuantity > 0.01 || utilizationPercent > 100
                    ? 'overloaded'
                    : cell.plannedOvertimeMinutes > 0
                      ? 'overtime'
                      : utilizationPercent >= 95
                        ? 'full'
                        : utilizationPercent > 0
                          ? 'loaded'
                          : 'free';
            capacityBuckets.push({ date, lineId: String(line._id), availableMinutes: freeRegularMinutes });
            return {
                ...cell,
                regularCapacityHours: Number((cell.regularCapacityMinutes / 60).toFixed(2)),
                plannedRegularHours: Number((cell.plannedRegularMinutes / 60).toFixed(2)),
                plannedOvertimeHours: Number((cell.plannedOvertimeMinutes / 60).toFixed(2)),
                freeRegularMinutes,
                utilizationPercent,
                outputLoadPercent,
                nominalQuantityCapacity: Math.round(cell.nominalQuantityCapacity),
                overloadQuantity: Math.ceil(cell.overloadQuantity),
                status,
            };
        });
        const totals = cells.reduce(
            (sum, cell) => ({
                capacity: sum.capacity + cell.regularCapacityMinutes,
                planned: sum.planned + cell.plannedRegularMinutes,
                overtime: sum.overtime + cell.plannedOvertimeMinutes,
                quantity: sum.quantity + cell.plannedQuantity,
                overload: sum.overload + cell.overloadQuantity,
            }),
            { capacity: 0, planned: 0, overtime: 0, quantity: 0, overload: 0 }
        );
        return {
            id: String(line._id),
            code: line.code,
            name: line.name,
            leaderName: line.leaderName,
            cells,
            summary: {
                regularCapacityHours: Number((totals.capacity / 60).toFixed(1)),
                plannedRegularHours: Number((totals.planned / 60).toFixed(1)),
                plannedOvertimeHours: Number((totals.overtime / 60).toFixed(1)),
                plannedQuantity: totals.quantity,
                overloadQuantity: totals.overload,
                utilizationPercent: totals.capacity ? Number(((totals.planned / totals.capacity) * 100).toFixed(1)) : 0,
            },
        };
    });

    dayRows.forEach((day) => {
        const cells = lineRows.map((line) => line.cells.find((cell: any) => cell.date === day.date));
        const capacity = cells.reduce((sum, cell) => sum + Number(cell?.regularCapacityMinutes || 0), 0);
        const planned = cells.reduce((sum, cell) => sum + Number(cell?.plannedRegularMinutes || 0), 0);
        day.regularCapacityHours = Number((capacity / 60).toFixed(1));
        day.plannedRegularHours = Number((planned / 60).toFixed(1));
        day.plannedOvertimeHours = Number(
            (cells.reduce((sum, cell) => sum + Number(cell?.plannedOvertimeMinutes || 0), 0) / 60).toFixed(1)
        );
        day.freeRegularHours = Number((Math.max(0, capacity - planned) / 60).toFixed(1));
        day.utilizationPercent = capacity ? Number(((planned / capacity) * 100).toFixed(1)) : 0;
        day.plannedQuantity = cells.reduce((sum, cell) => sum + Number(cell?.plannedQuantity || 0), 0);
        day.overloadedLineCount = cells.filter((cell) => cell?.status === 'overloaded').length;
    });

    capacityBuckets.sort(
        (left, right) => left.date.localeCompare(right.date) || left.lineId.localeCompare(right.lineId)
    );
    const orderProgress = await buildProductionOrderProgress(plant.id, orders);
    const materialReadiness = await loadReadinessRows(
        plant.id,
        orders.map((order) => String(order._id))
    );
    const materialByOrder = new Map(materialReadiness.map((row) => [row.order.id, row]));
    const plannedByOrder = new Map<string, Array<{ date: string; quantity: number }>>();
    plans
        .filter((plan) => String(plan.productionDate) >= today)
        .forEach((plan) => {
            (plan.allocations || []).forEach((allocation: any) => {
                const order = allocation.orderId
                    ? orders.find((candidate) => String(candidate._id) === String(allocation.orderId))
                    : orders.find((candidate) => candidate.code === allocation.orderCode);
                if (!order) return;
                const key = String(order._id);
                const rows = plannedByOrder.get(key) || [];
                rows.push({ date: String(plan.productionDate), quantity: Number(allocation.plannedQuantity || 0) });
                plannedByOrder.set(key, rows);
            });
        });

    const relevantOrders = orders
        .filter((order) => order.dueDate <= endDate || order.dueDate < today || plannedByOrder.has(String(order._id)))
        .sort(
            (left, right) =>
                String(left.dueDate).localeCompare(String(right.dueDate)) ||
                (PRIORITY_WEIGHT[right.priority] || 0) - (PRIORITY_WEIGHT[left.priority] || 0)
        );
    const orderRisks = relevantOrders.map((order) => {
        const orderId = String(order._id);
        const progress = orderProgress.get(orderId);
        const materials = materialByOrder.get(orderId);
        const remainingQuantity = Number(progress?.remainingQuantity || 0);
        const allocations = (plannedByOrder.get(orderId) || []).sort((left, right) =>
            left.date.localeCompare(right.date)
        );
        const plannedInHorizon = allocations
            .filter((row) => row.date >= startDate)
            .reduce((sum, row) => sum + row.quantity, 0);
        const committedThroughHorizon = allocations.reduce((sum, row) => sum + row.quantity, 0);
        const plannedByDue = allocations
            .filter((row) => row.date <= order.dueDate)
            .reduce((sum, row) => sum + row.quantity, 0);
        const remainingAfterPlan = Math.max(0, remainingQuantity - committedThroughHorizon);
        const uncoveredByDue = Math.max(0, remainingQuantity - plannedByDue);
        const item = itemById.get(String(order.itemId));
        const configuredRate = Number(item?.planningHourlyQuota || 0);
        const samples = itemRateSamples.get(String(order.itemId)) || [];
        const hourlyRate = configuredRate || medianCapacityRate(samples);
        const rateSource = configuredRate > 0 ? 'configured' : hourlyRate > 0 ? 'history' : 'missing';
        const confidence =
            configuredRate > 0 ? 'high' : samples.length >= 5 ? 'medium' : samples.length ? 'low' : 'none';
        const simulated = consumeCapacityForQuantity({
            buckets: capacityBuckets,
            quantity: remainingAfterPlan,
            hourlyRate,
            notBefore: maxDate(startDate, today, order.plannedStartDate)!,
        });
        const lastPlannedDate = allocations.at(-1)?.date;
        const projectedCompletionDate = maxDate(lastPlannedDate, simulated.projectedCompletionDate);
        const suggestedAllocations = simulated.allocations.map((allocation) => ({
            date: allocation.date,
            lineId: allocation.lineId,
            lineCode: lineById.get(allocation.lineId)?.code || allocation.lineId,
            quantity: allocation.quantity,
            hours: Number((allocation.minutes / 60).toFixed(2)),
            isAfterDue: allocation.date > order.dueDate,
        }));
        const suggestedBeforeDueQuantity = suggestedAllocations
            .filter((allocation) => !allocation.isAfterDue)
            .reduce((sum, allocation) => sum + allocation.quantity, 0);
        const suggestedAfterDueQuantity = suggestedAllocations
            .filter((allocation) => allocation.isAfterDue)
            .reduce((sum, allocation) => sum + allocation.quantity, 0);
        const risk = riskMeta({
            dueDate: order.dueDate,
            today,
            projectedCompletionDate,
            unallocatedQuantity: simulated.unallocatedQuantity,
            uncoveredByDue,
            hourlyRate,
            remainingQuantity,
        });
        return {
            id: orderId,
            code: order.code,
            customerName: order.customerName,
            itemId: String(order.itemId),
            itemCode: order.itemCode,
            itemName: order.itemName,
            priority: order.priority,
            status: order.status,
            plannedStartDate: order.plannedStartDate,
            dueDate: order.dueDate,
            remainingQuantity,
            plannedInHorizon,
            plannedByDue,
            uncoveredByDue,
            simulatedQuantity: Math.max(0, remainingAfterPlan - simulated.unallocatedQuantity),
            unallocatedQuantity: simulated.unallocatedQuantity,
            suggestedBeforeDueQuantity: Number(suggestedBeforeDueQuantity.toFixed(2)),
            suggestedAfterDueQuantity: Number(suggestedAfterDueQuantity.toFixed(2)),
            suggestedAllocations,
            projectedCompletionDate,
            hourlyRate: Number(hourlyRate.toFixed(2)),
            rateSource,
            rateSampleCount: samples.length,
            confidence,
            riskCode: risk.code,
            riskLabel: risk.label,
            severity: risk.severity,
            recommendation: risk.recommendation,
            materialStatus: materials?.status || 'unknown',
            materialReservationStatus: materials?.reservationStatus || 'not_configured',
            materialShortageLineCount: materials?.summary.shortageLineCount || 0,
            materialReadyDate: materials?.materialReadyDate,
        };
    });

    const allCells = lineRows.flatMap((line) => line.cells);
    const totalCapacityMinutes = allCells.reduce((sum, cell) => sum + cell.regularCapacityMinutes, 0);
    const totalPlannedMinutes = allCells.reduce((sum, cell) => sum + cell.plannedRegularMinutes, 0);
    const missingRateItemIds = new Set(
        orderRisks.filter((order) => order.rateSource === 'missing').map((order) => order.itemId)
    );
    return sendSuccess(
        res,
        {
            plant,
            range: { startDate, endDate, weeks, today },
            summary: {
                activeLineCount: lines.length,
                workingDayCount: dayRows.filter((day) => day.isWorkingDay).length,
                regularCapacityHours: Number((totalCapacityMinutes / 60).toFixed(1)),
                plannedRegularHours: Number((totalPlannedMinutes / 60).toFixed(1)),
                plannedOvertimeHours: Number(
                    (allCells.reduce((sum, cell) => sum + cell.plannedOvertimeMinutes, 0) / 60).toFixed(1)
                ),
                freeRegularHours: Number((Math.max(0, totalCapacityMinutes - totalPlannedMinutes) / 60).toFixed(1)),
                utilizationPercent: totalCapacityMinutes
                    ? Number(((totalPlannedMinutes / totalCapacityMinutes) * 100).toFixed(1))
                    : 0,
                overloadedCellCount: allCells.filter((cell) => cell.status === 'overloaded').length,
                overloadQuantity: allCells.reduce((sum, cell) => sum + cell.overloadQuantity, 0),
                atRiskOrderCount: orderRisks.filter((order) => order.severity >= 3).length,
                missingRateItemCount: missingRateItemIds.size,
                draftPlanDayCount: dayRows.filter((day) => day.planStatus === 'draft').length,
                suggestedQuantity: Number(
                    orderRisks.reduce((sum, order) => sum + order.simulatedQuantity, 0).toFixed(2)
                ),
                suggestedBeforeDueQuantity: Number(
                    orderRisks.reduce((sum, order) => sum + order.suggestedBeforeDueQuantity, 0).toFixed(2)
                ),
                suggestedAfterDueQuantity: Number(
                    orderRisks.reduce((sum, order) => sum + order.suggestedAfterDueQuantity, 0).toFixed(2)
                ),
                unallocatedQuantity: orderRisks.reduce((sum, order) => sum + order.unallocatedQuantity, 0),
            },
            days: dayRows,
            lines: lineRows,
            orders: orderRisks.sort(
                (left, right) => right.severity - left.severity || left.dueDate.localeCompare(right.dueDate)
            ),
            dataQuality: {
                missingRateItems: [...missingRateItemIds].map((id) => {
                    const item = itemById.get(id);
                    return { id, code: item?.code, name: item?.name };
                }),
                invalidAllocationCount: allCells.flatMap((cell) => cell.allocations).filter((row) => !row.validWindow)
                    .length,
            },
        },
        'Đã phân tích năng lực và cam kết giao hàng'
    );
};
