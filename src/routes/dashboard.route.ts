import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import { dashboardService } from '@/services';

const router = Router();

router.use(authenticate);

router.get('/overview', asyncHandler(dashboardService.getDashboardOverview));
router.get('/insights', asyncHandler(dashboardService.getDashboardInsights));
// Bản đồ vị trí máy chỉ dành cho Giám đốc trở lên.
router.get('/asset-locations', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(dashboardService.getAssetLocations));
router.get('/stats', asyncHandler(dashboardService.getDashboardStats));
router.get('/charts', asyncHandler(dashboardService.getDashboardCharts));

export default router;
