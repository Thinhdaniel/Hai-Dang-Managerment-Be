import { Router } from 'express';
import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { explainVariance } from '@/services/variance.service';
import asyncHandler from '@/utils/asyncHandler';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.DIRECTOR_UP));
router.post('/explain', asyncHandler(explainVariance));

// Keep the former endpoint during the FE/BE rollout; it only exposes variance analysis.
export const legacyVarianceRouter = Router();
legacyVarianceRouter.use(authenticate);
legacyVarianceRouter.use(authorize(...ROLE_GROUPS.DIRECTOR_UP));
legacyVarianceRouter.post('/variance', asyncHandler(explainVariance));

export default router;
