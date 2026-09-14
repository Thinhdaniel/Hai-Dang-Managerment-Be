import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { excelUpload } from '@/middlewares/multerMiddleware';
import { validateObjectIdParams } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as productionCapacityService from '@/services/production-capacity.service';
import * as productionControlTowerService from '@/services/production-control-tower.service';
import * as productionPilotService from '@/services/production-pilot.service';
import * as productionRolloutService from '@/services/production-rollout.service';
import * as productionMaterialService from '@/services/production-material.service';
import * as productionOpeningBalanceService from '@/services/production-opening-balance.service';
import * as productionOrderService from '@/services/production-order.service';
import * as productionAccessService from '@/services/production-access.service';
import * as productionPlanService from '@/services/production-plan.service';
import * as productionQcRecordService from '@/services/production-qc-record.service';
import * as productionQcOpeningBalanceService from '@/services/production-qc-opening-balance.service';
import * as productionQcReportService from '@/services/production-qc-report.service';
import * as productionReminderService from '@/services/production-reminder.service';
import * as productionReportService from '@/services/production-report.service';
import * as productionScheduleService from '@/services/production-schedule.service';
import * as productionService from '@/services/production.service';
import asyncHandler from '@/utils/asyncHandler';
import {
    addProductionDayLineSchema,
    applyProductionMasterPlanSchema,
    approveProductionBomSchema,
    carryOverProductionPlanSchema,
    configureProductionLineSchema,
    configureProductionOperationTracksSchema,
    correctProductionLineSetupSchema,
    createProductionDaySchema,
    createProductionItemSchema,
    createProductionLineSchema,
    createProductionOperationSchema,
    createProductionOpeningBalanceSchema,
    createProductionOrderSchema,
    createProductionQcOpeningBalanceSchema,
    createProductionPlanSchema,
    createProductionRunSchema,
    importProductionOpeningBalanceSchema,
    importProductionOrderSchema,
    importProductionQcOpeningBalanceSchema,
    publishProductionPlanSchema,
    releaseProductionMaterialReservationSchema,
    reopenProductionPlanSchema,
    updateProductionItemSchema,
    updateProductionLineSchema,
    updateProductionOperationSchema,
    updateProductionOrderSchema,
    updateProductionItemOperationsSchema,
    updateProductionPlanSchema,
    updateProductionScheduleTemplateSchema,
    updateProductionTimeSlotsSchema,
    upsertHourlyProductionEntrySchema,
    upsertHourlyOperationEntriesSchema,
    upsertHourlyQcEntrySchema,
    upsertProductionQcRecordSchema,
    transitionProductionDaySchema,
    testProductionReminderSchema,
    updateProductionReminderSettingsSchema,
    voidProductionOpeningBalanceSchema,
    voidProductionQcOpeningBalanceSchema,
    saveProductionBomSchema,
    syncProductionControlTowerSchema,
    acceptProductionPilotVarianceSchema,
    addProductionPilotLimitationSchema,
    captureProductionPilotDaySchema,
    createProductionPilotRunSchema,
    saveProductionPilotReferenceSchema,
    signoffProductionPilotSchema,
    updateProductionPilotChecklistSchema,
    updateProductionPilotLimitationSchema,
    updateProductionPilotStatusSchema,
    transitionProductionRolloutSchema,
} from '@/validations/production.validation';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
// Lớp base gồm cả Tổ trưởng để họ nhập số theo giờ; các route quản trị bên dưới
// vẫn tự gate MANAGEMENT nên tổ trưởng chỉ chạm được luồng nhập liệu.
router.use(authorize(...ROLE_GROUPS.PRODUCTION_FIELD));

// Endpoint trạng thái phải đứng trước middleware chặn để FE có thể giải thích đúng lý do.
router.get('/access', asyncHandler(productionAccessService.getProductionAccess));
router.get(
    '/rollout/portfolio',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    asyncHandler(productionRolloutService.getProductionRolloutPortfolio)
);
router.post(
    '/rollout/plants/:plantId/transition',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectIdParams('plantId'),
    validator(transitionProductionRolloutSchema),
    asyncHandler(productionRolloutService.transitionProductionRollout)
);
router.use(productionAccessService.requireProductionEnabled);

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

router.get('/operations', asyncHandler(productionService.listProductionOperations));
router.post(
    '/operations',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionOperationSchema),
    asyncHandler(productionService.createProductionOperation)
);
router.patch(
    '/operations/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionOperationSchema),
    asyncHandler(productionService.updateProductionOperation)
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
router.put(
    '/items/:id/operations',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionItemOperationsSchema),
    asyncHandler(productionService.updateProductionItemOperations)
);

router.get(
    '/qc/reports/summary',
    authorize(...ROLE_GROUPS.PRODUCTION_QC_REPORT),
    asyncHandler(productionQcReportService.getProductionQcReport)
);
router.get(
    '/qc/reports/export',
    authorize(...ROLE_GROUPS.PRODUCTION_QC_REPORT),
    asyncHandler(productionQcReportService.exportProductionQcReport)
);
router.get(
    '/qc/opening-balances',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionQcOpeningBalanceService.listProductionQcOpeningBalances)
);
router.get(
    '/qc/opening-balances/template',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionQcOpeningBalanceService.downloadProductionQcOpeningTemplate)
);
router.post(
    '/qc/opening-balances/manual',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionQcOpeningBalanceSchema),
    asyncHandler(productionQcOpeningBalanceService.createManualProductionQcOpeningBalance)
);
router.post(
    '/qc/opening-balances/import/preview',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    validator(importProductionQcOpeningBalanceSchema),
    asyncHandler(productionQcOpeningBalanceService.previewProductionQcOpeningImport)
);
router.post(
    '/qc/opening-balances/import/confirm',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    validator(importProductionQcOpeningBalanceSchema),
    asyncHandler(productionQcOpeningBalanceService.confirmProductionQcOpeningImport)
);
router.post(
    '/qc/opening-balances/:id/void',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(voidProductionQcOpeningBalanceSchema),
    asyncHandler(productionQcOpeningBalanceService.voidProductionQcOpeningBalance)
);

router.get(
    '/opening-balances',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionOpeningBalanceService.listProductionOpeningBalances)
);
router.get(
    '/opening-balances/template',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionOpeningBalanceService.downloadProductionOpeningBalanceTemplate)
);
router.post(
    '/opening-balances/manual',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionOpeningBalanceSchema),
    asyncHandler(productionOpeningBalanceService.createManualProductionOpeningBalance)
);
router.post(
    '/opening-balances/import/preview',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    validator(importProductionOpeningBalanceSchema),
    asyncHandler(productionOpeningBalanceService.previewProductionOpeningBalanceImport)
);
router.post(
    '/opening-balances/import/confirm',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    validator(importProductionOpeningBalanceSchema),
    asyncHandler(productionOpeningBalanceService.confirmProductionOpeningBalanceImport)
);
router.post(
    '/opening-balances/:id/void',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(voidProductionOpeningBalanceSchema),
    asyncHandler(productionOpeningBalanceService.voidProductionOpeningBalance)
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
    '/orders/import/template',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionOrderService.downloadProductionOrderTemplate)
);
router.get(
    '/capacity',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionCapacityService.getProductionCapacity)
);
router.get(
    '/control-tower',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionControlTowerService.getProductionControlTower)
);
router.post(
    '/control-tower/sync-statuses',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(syncProductionControlTowerSchema),
    asyncHandler(productionControlTowerService.syncProductionControlTowerStatuses)
);
router.get(
    '/pilot-runs',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionPilotService.listProductionPilotRuns)
);
router.post(
    '/pilot-runs',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionPilotRunSchema),
    asyncHandler(productionPilotService.createProductionPilotRun)
);
router.get(
    '/pilot-runs/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    asyncHandler(productionPilotService.getProductionPilotRun)
);
router.patch(
    '/pilot-runs/:id/status',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionPilotStatusSchema),
    asyncHandler(productionPilotService.updateProductionPilotRunStatus)
);
router.post(
    '/pilot-runs/:id/days/capture',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(captureProductionPilotDaySchema),
    asyncHandler(productionPilotService.captureProductionPilotDay)
);
router.put(
    '/pilot-runs/:id/days/:date/reference',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(saveProductionPilotReferenceSchema),
    asyncHandler(productionPilotService.saveProductionPilotReference)
);
router.post(
    '/pilot-runs/:id/days/:date/accept-variance',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(acceptProductionPilotVarianceSchema),
    asyncHandler(productionPilotService.acceptProductionPilotVariance)
);
router.patch(
    '/pilot-runs/:id/checklist/:code',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionPilotChecklistSchema),
    asyncHandler(productionPilotService.updateProductionPilotChecklist)
);
router.post(
    '/pilot-runs/:id/limitations',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(addProductionPilotLimitationSchema),
    asyncHandler(productionPilotService.addProductionPilotLimitation)
);
router.patch(
    '/pilot-runs/:id/limitations/:limitationId',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionPilotLimitationSchema),
    asyncHandler(productionPilotService.updateProductionPilotLimitation)
);
router.post(
    '/pilot-runs/:id/sign-off',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectIdParams('id'),
    validator(signoffProductionPilotSchema),
    asyncHandler(productionPilotService.signoffProductionPilotRun)
);
router.post(
    '/capacity/apply-suggestions',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(applyProductionMasterPlanSchema),
    asyncHandler(productionPlanService.applyProductionMasterPlan)
);
router.get('/boms', authorize(...ROLE_GROUPS.MANAGEMENT), asyncHandler(productionMaterialService.listProductionBoms));
router.put(
    '/items/:id/bom',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(saveProductionBomSchema),
    asyncHandler(productionMaterialService.saveProductionBomDraft)
);
router.post(
    '/boms/:id/approve',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(approveProductionBomSchema),
    asyncHandler(productionMaterialService.approveProductionBom)
);
router.get(
    '/material-readiness',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionMaterialService.getProductionMaterialReadiness)
);
router.post(
    '/orders/:id/materials/reserve',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    asyncHandler(productionMaterialService.reserveProductionOrderMaterials)
);
router.post(
    '/orders/:id/materials/release',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(releaseProductionMaterialReservationSchema),
    asyncHandler(productionMaterialService.releaseProductionOrderMaterials)
);
router.post(
    '/orders/:id/materials/snapshot',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    asyncHandler(productionMaterialService.snapshotProductionOrderReadiness)
);
router.post(
    '/orders/import/preview',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    validator(importProductionOrderSchema),
    asyncHandler(productionOrderService.previewProductionOrderImport)
);
router.post(
    '/orders/import/confirm',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    validator(importProductionOrderSchema),
    asyncHandler(productionOrderService.confirmProductionOrderImport)
);
router.get('/orders', authorize(...ROLE_GROUPS.MANAGEMENT), asyncHandler(productionOrderService.listProductionOrders));
router.post(
    '/orders',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createProductionOrderSchema),
    asyncHandler(productionOrderService.createProductionOrder)
);
router.get(
    '/orders/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    asyncHandler(productionOrderService.getProductionOrder)
);
router.patch(
    '/orders/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    validator(updateProductionOrderSchema),
    asyncHandler(productionOrderService.updateProductionOrder)
);

router.get(
    '/schedule-templates',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionScheduleService.listProductionScheduleTemplates)
);
router.put(
    '/schedule-templates/:weekday',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(updateProductionScheduleTemplateSchema),
    asyncHandler(productionScheduleService.updateProductionScheduleTemplate)
);
router.delete(
    '/schedule-templates/:weekday',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionScheduleService.resetProductionScheduleTemplate)
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
router.get('/board', authorize(...ROLE_GROUPS.MANAGEMENT), asyncHandler(productionService.getProductionBoard));
router.get('/reminders/status', asyncHandler(productionReminderService.getProductionReminderStatus));
router.post(
    '/reminders/test',
    validator(testProductionReminderSchema),
    asyncHandler(productionReminderService.sendProductionReminderTest)
);
router.get(
    '/reminders/settings',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(productionReminderService.getProductionReminderSettings)
);
router.put(
    '/reminders/settings',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(updateProductionReminderSettingsSchema),
    asyncHandler(productionReminderService.updateProductionReminderSettings)
);
router.get('/days/lookup', asyncHandler(productionService.lookupProductionDay));
router.get('/days', asyncHandler(productionService.listProductionDays));
router.post(
    '/days',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validator(createProductionDaySchema),
    asyncHandler(productionService.createProductionDay)
);
router.post(
    '/days/:id/submit',
    authorize(...ROLE_GROUPS.FIELD),
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
router.post(
    '/days/:id/apply-schedule-template',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('id'),
    asyncHandler(productionService.applyProductionScheduleTemplate)
);
router.post(
    '/days/:dayId/lines',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('dayId'),
    validator(addProductionDayLineSchema),
    asyncHandler(productionService.addProductionDayLine)
);
router.post(
    '/days/:dayId/lines/sync-catalog',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('dayId'),
    asyncHandler(productionService.syncProductionDayLineMetadata)
);
router.delete(
    '/days/:dayId/lines/:lineId',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('dayId', 'lineId'),
    asyncHandler(productionService.removeProductionDayLine)
);
router.put(
    '/days/:dayId/lines/:lineId',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(configureProductionLineSchema),
    asyncHandler(productionService.configureProductionLine)
);
router.post(
    '/days/:dayId/lines/:lineId/runs',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(createProductionRunSchema),
    asyncHandler(productionService.createProductionRun)
);
router.put(
    '/days/:dayId/lines/:lineId/operation-tracks',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(configureProductionOperationTracksSchema),
    asyncHandler(productionService.configureProductionOperationTracks)
);
router.post(
    '/days/:dayId/lines/:lineId/correct-setup',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectIdParams('dayId', 'lineId'),
    validator(correctProductionLineSetupSchema),
    asyncHandler(productionService.correctProductionLineSetup)
);
router.delete(
    '/days/:dayId/lines/:lineId/runs/:runId',
    authorize(...ROLE_GROUPS.FIELD),
    validateObjectIdParams('dayId', 'lineId', 'runId'),
    asyncHandler(productionService.deleteProductionRun)
);
router.put(
    '/days/:dayId/lines/:lineId/entries/:slotKey',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(upsertHourlyProductionEntrySchema),
    asyncHandler(productionService.upsertHourlyProductionEntry)
);
router.delete(
    '/days/:dayId/lines/:lineId/entries/:entryId',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId', 'entryId'),
    asyncHandler(productionService.deleteHourlyProductionEntry)
);
router.put(
    '/days/:dayId/lines/:lineId/operation-entries/:slotKey',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(upsertHourlyOperationEntriesSchema),
    asyncHandler(productionService.upsertHourlyOperationEntries)
);
router.delete(
    '/days/:dayId/lines/:lineId/operation-entries/:entryId',
    authorize(...ROLE_GROUPS.PRODUCTION_ENTRY),
    validateObjectIdParams('dayId', 'lineId', 'entryId'),
    asyncHandler(productionService.deleteHourlyOperationEntry)
);
router.put(
    '/days/:dayId/lines/:lineId/qc-entries/:slotKey',
    authorize(...ROLE_GROUPS.PRODUCTION_QC_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(upsertHourlyQcEntrySchema),
    asyncHandler(productionService.upsertHourlyQcEntry)
);
router.delete(
    '/days/:dayId/lines/:lineId/qc-entries/:entryId',
    authorize(...ROLE_GROUPS.PRODUCTION_QC_ENTRY),
    validateObjectIdParams('dayId', 'lineId', 'entryId'),
    asyncHandler(productionService.deleteHourlyQcEntry)
);
router.put(
    '/days/:dayId/lines/:lineId/qc-records/:slotKey',
    authorize(...ROLE_GROUPS.PRODUCTION_QC_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    validator(upsertProductionQcRecordSchema),
    asyncHandler(productionQcRecordService.upsertProductionQcRecord)
);
router.delete(
    '/days/:dayId/lines/:lineId/qc-records/:slotKey',
    authorize(...ROLE_GROUPS.PRODUCTION_QC_ENTRY),
    validateObjectIdParams('dayId', 'lineId'),
    asyncHandler(productionQcRecordService.deleteProductionQcRecord)
);

export default router;
