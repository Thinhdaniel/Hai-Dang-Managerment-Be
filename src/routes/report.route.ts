import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import asyncHandler from '@/utils/asyncHandler';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as reportService from '@/services/report.service';

const router = Router();

router.use(authenticate);

router.get(
    '/facility-cost-summary',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(reportService.getFacilityCostSummary)
);

router.get(
    '/facility-cost-summary/export-excel',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    asyncHandler(reportService.exportFacilityCostSummaryExcel)
);

export default router;
