import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import {
    getFloorMap,
    getFloorMachineStats,
    resolveFloorZoneAnchor,
    saveFloorZones,
    saveFloorPositions,
    getFloorMapRevisions,
    rollbackFloorMapRevision,
    getFloorMapRealityHealth,
} from '@/services/floor-map.service';
import {
    evaluateRealityOperationsNow,
    getRealityOperations,
    updateRealityAlertRule,
    updateRealityOperationalAlert,
} from '@/services/reality-operations.service';
import validator from '@/middlewares/validator';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import {
    evaluateRealityOperationsSchema,
    updateRealityAlertRuleSchema,
    updateRealityOperationalAlertSchema,
} from '@/validations/reality-operations.validation';

const router = Router();

router.use(authenticate);

// Xem sơ đồ: mọi người dùng đã đăng nhập. Thiết lập (khu vực + vị trí máy): Giám đốc trở lên.
router.get('/', asyncHandler(getFloorMap));
router.get('/reality-health', asyncHandler(getFloorMapRealityHealth));
router.get('/operations', authorize(...ROLE_GROUPS.MANAGEMENT), asyncHandler(getRealityOperations));
router.patch(
    '/operations/rule',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validator(updateRealityAlertRuleSchema),
    asyncHandler(updateRealityAlertRule)
);
router.patch(
    '/operations/alerts/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateRealityOperationalAlertSchema),
    asyncHandler(updateRealityOperationalAlert)
);
router.post(
    '/operations/evaluate',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validator(evaluateRealityOperationsSchema),
    asyncHandler(evaluateRealityOperationsNow)
);
router.get('/zones/anchor/:code', asyncHandler(resolveFloorZoneAnchor));
router.get('/machines/:id/stats', asyncHandler(getFloorMachineStats));
router.get('/revisions', asyncHandler(getFloorMapRevisions));
router.post('/revisions/:id/rollback', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(rollbackFloorMapRevision));
router.put('/zones', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(saveFloorZones));
router.patch('/positions', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(saveFloorPositions));

export default router;
