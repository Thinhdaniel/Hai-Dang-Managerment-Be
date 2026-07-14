import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import { dashboardService } from '@/services';
import * as executiveBriefingService from '@/services/executive-briefing.service';

const router = Router();

router.use(authenticate);

router.get(
    '/briefings/latest',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    asyncHandler(executiveBriefingService.getLatestExecutiveBriefing)
);
router.get(
    '/briefings',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    asyncHandler(executiveBriefingService.listExecutiveBriefings)
);
router.post(
    '/briefings/refresh',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    asyncHandler(executiveBriefingService.refreshExecutiveBriefing)
);
router.get(
    '/briefings/:id',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    asyncHandler(executiveBriefingService.getExecutiveBriefingById)
);
router.get('/overview', asyncHandler(dashboardService.getDashboardOverview));
router.get('/insights', asyncHandler(dashboardService.getDashboardInsights));
// Bản đồ vị trí máy chỉ dành cho Giám đốc trở lên.
router.get('/asset-locations', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(dashboardService.getAssetLocations));
router.get('/stats', asyncHandler(dashboardService.getDashboardStats));
router.get('/charts', asyncHandler(dashboardService.getDashboardCharts));

export default router;
