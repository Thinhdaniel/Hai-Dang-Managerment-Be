import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as supplyRequestController from '@/controllers/supply-request.controller';
import {
    approveSupplyRequestSchema,
    createSupplyRequestSchema,
    rejectSupplyRequestSchema,
    updateSupplyRequestSchema,
} from '@/validations/supply-request.validation';

const router = Router();

router.use(authenticate);

// GET danh sách — tất cả roles xem (filter theo plant tự động trong service)
router.get('/', supplyRequestController.getAllSupplyRequests);

// POST tạo — Quản lý trở lên (service sẽ chặn CS1)
router.post(
    '/',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validator(createSupplyRequestSchema),
    supplyRequestController.createSupplyRequest
);

// GET chi tiết
router.get('/:id/export-xlsx', validateObjectId, supplyRequestController.exportSupplyRequestXlsx);
router.get('/:id', validateObjectId, supplyRequestController.getSupplyRequestById);

// PUT cập nhật items — CS1 chỉnh sửa SL, chỉ được khi status=pending
router.put(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateSupplyRequestSchema),
    supplyRequestController.updateSupplyRequest
);

// PATCH duyệt (chỉ đổi status, không tạo distribution) — chỉ CS1
router.patch(
    '/:id/approve',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(approveSupplyRequestSchema),
    supplyRequestController.approveSupplyRequest
);

// PATCH duyệt + cấp phát tự động (legacy, giữ lại) — chỉ CS1
router.patch(
    '/:id/approve-and-distribute',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    supplyRequestController.approveAndDistribute
);

// PATCH từ chối — chỉ CS1
router.patch(
    '/:id/reject',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(rejectSupplyRequestSchema),
    supplyRequestController.rejectSupplyRequest
);

export default router;
