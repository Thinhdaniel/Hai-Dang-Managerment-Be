import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectIdParams } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as productionPlanService from '@/services/production-plan.service';
import * as productionReportService from '@/services/production-report.service';
import * as productionService from '@/services/production.service';
import asyncHandler from '@/utils/asyncHandler';
import {
    carryOverProductionPlanSchema,
    configureProductionLineSchema,
    createProductionDaySchema,
    createProductionItemSchema,
    createProductionLineSchema,
    createProductionPlanSchema,
    createProductionRunSchema,
    publishProductionPlanSchema,
    reopenProductionPlanSchema,
    updateProductionItemSchema,
    updateProductionLineSchema,
    updateProductionPlanSchema,
    updateProductionTimeSlotsSchema,
    upsertHourlyProductionEntrySchema,
    transitionProductionDaySchema,
} from '@/validations/production.validation';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.FIELD));

router.get('/lines', asyncHandler(productionService.listProductionLines));
router.post(
    '/lines',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionLineSchema),
    asyncHandler(productionService.createProductionLine)
);
router.patch(
    '/lines/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionLineSchema),
    asyncHandler(productionService.updateProductionLine)
);

router.get('/items', asyncHandler(productionService.listProductionItems));
router.post(
    '/items',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionItemSchema),
    asyncHandler(productionService.createProductionItem)
);
router.patch(
    '/items/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionItemSchema),
    asyncHandler(productionService.updateProductionItem)
);

router.get(
    '/reports/summary',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionReportService.getProductionReport)
);
router.get(
    '/reports/export',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionReportService.exportProductionReport)
);

router.get(
    '/plans/lookup',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionPlanService.lookupProductionPlan)
);
router.post(
    '/plans',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionPlanSchema),
    asyncHandler(productionPlanService.createProductionPlan)
);
router.put(
    '/plans/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionPlanSchema),
    asyncHandler(productionPlanService.updateProductionPlan)
);
router.post(
    '/plans/:id/publish',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(publishProductionPlanSchema),
    asyncHandler(productionPlanService.publishProductionPlan)
);
router.post(
    '/plans/:id/reopen',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(reopenProductionPlanSchema),
    asyncHandler(productionPlanService.reopenProductionPlan)
);
router.post(
    '/plans/:id/carry-over',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(carryOverProductionPlanSchema),
    asyncHandler(productionPlanService.carryOverProductionPlan)
);

router.get('/monitor', authorize(...ROLE_GROUPS.MANAGEMENT), asyncHandler(productionService.getProductionMonitor));
router.get('/days/lookup', asyncHandler(productionService.lookupProductionDay));
router.get('/days', asyncHandler(productionService.listProductionDays));
router.post('/days', validator(createProductionDaySchema), asyncHandler(productionService.createProductionDay));
router.post(
    '/days/:id/submit',
    validateObjectIdParams('id'),
    validator(transitionProductionDaySchema),
    asyncHandler(productionService.submitProductionDay)
);
router.post(
    '/days/:id/lock',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(transitionProductionDaySchema),
    asyncHandler(productionService.lockProductionDay)
);
router.post(
    '/days/:id/reopen',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(transitionProductionDaySchema),
    asyncHandler(productionService.reopenProductionDay)
);
router.get(
    '/days/:id/export',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    asyncHandler(productionService.exportProductionDay)
);
router.get('/days/:id', validateObjectIdParams('id'), asyncHandler(productionService.getProductionDay));
router.patch(
    '/days/:id/time-slots',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionTimeSlotsSchema),
    asyncHandler(productionService.updateProductionTimeSlots)
);
router.put(
    '/days/:dayId/lines/:lineId',
    validateObjectIdParams('dayId', 'lineId'),
    validator(configureProductionLineSchema),
    asyncHandler(productionService.configureProductionLine)
);
router.post(
    '/days/:dayId/lines/:lineId/runs',
    validateObjectIdParams('dayId', 'lineId'),
    validator(createProductionRunSchema),
    asyncHandler(productionService.createProductionRun)
);
router.delete(
    '/days/:dayId/lines/:lineId/runs/:runId',
    validateObjectIdParams('dayId', 'lineId', 'runId'),
    asyncHandler(productionService.deleteProductionRun)
);
router.put(
    '/days/:dayId/lines/:lineId/entries/:slotKey',
    validateObjectIdParams('dayId', 'lineId'),
    validator(upsertHourlyProductionEntrySchema),
    asyncHandler(productionService.upsertHourlyProductionEntry)
);
router.delete(
    '/days/:dayId/lines/:lineId/entries/:entryId',
    validateObjectIdParams('dayId', 'lineId', 'entryId'),
    asyncHandler(productionService.deleteHourlyProductionEntry)
);

export default router;
