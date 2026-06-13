import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { maintenanceService } from '@/services';
import {
    approveMaintenanceSchema,
    completeMaintenanceSchema,
    createMaintenanceSchema,
    rejectMaintenanceSchema,
    updateMaintenanceSchema,
} from '@/validations/maintenance.validation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    authorize(...ROLE_GROUPS.FIELD),
    validator(createMaintenanceSchema),
    asyncHandler(maintenanceService.createMaintenance)
);
router.get('/', asyncHandler(maintenanceService.getAllMaintenances));
router.get('/report', asyncHandler(maintenanceService.getMaintenanceReport));
router.get('/asset/:assetId', validateObjectId, asyncHandler(maintenanceService.getMaintenanceByAsset));
router.get('/:id/export-xlsx', validateObjectId, asyncHandler(maintenanceService.exportMaintenanceXlsx));
router.get('/:id', validateObjectId, asyncHandler(maintenanceService.getMaintenanceById));
router.patch(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateMaintenanceSchema),
    asyncHandler(maintenanceService.updateMaintenance)
);
router.delete(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    asyncHandler(maintenanceService.deleteMaintenance)
);
router.patch(
    '/:id/complete',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(completeMaintenanceSchema),
    asyncHandler(maintenanceService.completeMaintenance)
);
router.patch(
    '/:id/approve',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(approveMaintenanceSchema),
    asyncHandler(maintenanceService.approveMaintenance)
);
router.patch(
    '/:id/reject',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(rejectMaintenanceSchema),
    asyncHandler(maintenanceService.rejectMaintenance)
);

export default router;
