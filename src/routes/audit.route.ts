import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import { getLatestAudit, listAudits, runAuditNow } from '@/services/audit.service';

const router = Router();

// Kiểm toán đêm chỉ dành cho Giám đốc trở lên (giống bản tin AI).
router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.DIRECTOR_UP));

router.get('/latest', asyncHandler(getLatestAudit));
router.get('/', asyncHandler(listAudits));
router.post('/run', asyncHandler(runAuditNow));

export default router;
