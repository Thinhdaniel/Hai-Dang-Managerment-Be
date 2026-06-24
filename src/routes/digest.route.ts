import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import { generateDigestNow, getLatestDigest, listDigests } from '@/services/digest.service';
import { explainVariance } from '@/services/variance.service';

const router = Router();

// Bản tin AI chỉ dành cho Giám đốc trở lên.
router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.DIRECTOR_UP));

router.get('/latest', asyncHandler(getLatestDigest));
router.get('/', asyncHandler(listDigests));
router.post('/generate', asyncHandler(generateDigestNow));
router.post('/variance', asyncHandler(explainVariance));

export default router;
