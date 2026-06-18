import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import * as dataQualityService from '@/services/data-quality.service';
import asyncHandler from '@/utils/asyncHandler';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.ADMIN_ONLY));

router.get('/overview', asyncHandler(dataQualityService.getDataQualityOverview));

export default router;
