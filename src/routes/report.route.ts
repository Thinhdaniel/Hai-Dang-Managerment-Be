import { Router } from 'express';
import { USER_ROLE } from '@/constant/allowedRoles';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import asyncHandler from '@/utils/asyncHandler';
import * as reportService from '@/services/report.service';

const router = Router();

router.use(authenticate);

router.get(
    '/facility-cost-summary',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    asyncHandler(reportService.getFacilityCostSummary)
);

router.get(
    '/facility-cost-summary/export-excel',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    asyncHandler(reportService.exportFacilityCostSummaryExcel)
);

export default router;
