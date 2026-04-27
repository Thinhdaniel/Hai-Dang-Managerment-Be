import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { dashboardService } from '@/services';

const router = Router();

router.use(authenticate);

router.get('/overview', asyncHandler(dashboardService.getDashboardOverview));
router.get('/stats', asyncHandler(dashboardService.getDashboardStats));
router.get('/charts', asyncHandler(dashboardService.getDashboardCharts));

export default router;
