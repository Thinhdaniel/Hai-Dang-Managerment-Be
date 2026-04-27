import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { maintenanceService } from '@/services';
import {
    completeMaintenanceSchema,
    createMaintenanceSchema,
    updateMaintenanceSchema,
} from '@/validations/maintenance.validation';
import { USER_ROLE } from '@/constant/allowedRoles';

const router = Router();

router.use(authenticate);

router.post('/', validator(createMaintenanceSchema), asyncHandler(maintenanceService.createMaintenance));
router.get('/', asyncHandler(maintenanceService.getAllMaintenances));
router.get('/asset/:assetId', validateObjectId, asyncHandler(maintenanceService.getMaintenanceByAsset));
router.get('/:id', validateObjectId, asyncHandler(maintenanceService.getMaintenanceById));
router.patch(
    '/:id',
    validateObjectId,
    validator(updateMaintenanceSchema),
    asyncHandler(maintenanceService.updateMaintenance)
);
router.delete(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    asyncHandler(maintenanceService.deleteMaintenance)
);
router.patch(
    '/:id/complete',
    validateObjectId,
    validator(completeMaintenanceSchema),
    asyncHandler(maintenanceService.completeMaintenance)
);

export default router;
