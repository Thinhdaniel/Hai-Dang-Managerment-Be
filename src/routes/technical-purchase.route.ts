import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as technicalPurchaseController from '@/controllers/technical-purchase.controller';
import {
    approveTechnicalPurchaseSchema,
    createTechnicalPurchaseSchema,
    rejectTechnicalPurchaseSchema,
    updateTechnicalPurchaseSchema,
} from '@/validations/technical-purchase.validation';

const router = Router();

router.use(authenticate);

// GET danh sách — mọi role (service tự lọc: kỹ thuật chỉ thấy phiếu của mình)
router.get('/', technicalPurchaseController.getAllTechnicalPurchaseRequests);

// POST tạo — bộ phận kỹ thuật (STAFF) trở lên
router.post(
    '/',
    authorize(...ROLE_GROUPS.FIELD),
    validator(createTechnicalPurchaseSchema),
    technicalPurchaseController.createTechnicalPurchaseRequest
);

router.get('/:id/export-xlsx', validateObjectId, technicalPurchaseController.exportTechnicalPurchaseRequestXlsx);
router.get('/:id', validateObjectId, technicalPurchaseController.getTechnicalPurchaseRequestById);

// PUT cập nhật — chủ phiếu hoặc quản lý, chỉ khi đang chờ duyệt
router.put(
    '/:id',
    authorize(...ROLE_GROUPS.FIELD),
    validateObjectId,
    validator(updateTechnicalPurchaseSchema),
    technicalPurchaseController.updateTechnicalPurchaseRequest
);

// PATCH duyệt — quản lý trở lên
router.patch(
    '/:id/approve',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(approveTechnicalPurchaseSchema),
    technicalPurchaseController.approveTechnicalPurchaseRequest
);

// PATCH từ chối — quản lý trở lên
router.patch(
    '/:id/reject',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(rejectTechnicalPurchaseSchema),
    technicalPurchaseController.rejectTechnicalPurchaseRequest
);

export default router;
