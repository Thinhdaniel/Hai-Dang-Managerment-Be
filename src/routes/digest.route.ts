import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import {
    approveDigest,
    downloadDigestPdfFile,
    generateDigestNow,
    getDigestById,
    getLatestDigest,
    listDigests,
    publishDigest,
    recordDigestView,
    regenerateDigestCover,
    reopenDigest,
    updateDigestCover,
    updateDigestEditorial,
    validateDigestNow,
} from '@/services/digest.service';
import { explainVariance } from '@/services/variance.service';

const router = Router();

// Bản tin AI chỉ dành cho Giám đốc trở lên.
router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.DIRECTOR_UP));

router.get('/latest', asyncHandler(getLatestDigest));
router.get('/', asyncHandler(listDigests));
router.post('/generate', asyncHandler(generateDigestNow));
router.post('/variance', asyncHandler(explainVariance));
router.get('/:id', asyncHandler(getDigestById));
router.patch('/:id/editorial', asyncHandler(updateDigestEditorial));
router.patch('/:id/cover', asyncHandler(updateDigestCover));
router.post('/:id/cover/regenerate', asyncHandler(regenerateDigestCover));
router.post('/:id/validate', asyncHandler(validateDigestNow));
router.post('/:id/approve', asyncHandler(approveDigest));
router.post('/:id/reopen', asyncHandler(reopenDigest));
router.post('/:id/publish', asyncHandler(publishDigest));
router.post('/:id/view', asyncHandler(recordDigestView));
router.get('/:id/pdf', asyncHandler(downloadDigestPdfFile));

export default router;
