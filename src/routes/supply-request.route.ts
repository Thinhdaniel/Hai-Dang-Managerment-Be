import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { USER_ROLE } from '@/constant/allowedRoles';
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

// POST tạo — chỉ Staff và Manager thuộc CS khác (service sẽ chặn CS1)
router.post(
    '/',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER, USER_ROLE.STAFF),
    validator(createSupplyRequestSchema),
    supplyRequestController.createSupplyRequest
);

// GET chi tiết
router.get('/:id/export-xlsx', validateObjectId, supplyRequestController.exportSupplyRequestXlsx);
router.get('/:id', validateObjectId, supplyRequestController.getSupplyRequestById);

// PUT cập nhật items — CS1 chỉnh sửa SL, chỉ được khi status=pending
router.put(
    '/:id',
    validateObjectId,
    validator(updateSupplyRequestSchema),
    supplyRequestController.updateSupplyRequest
);

// PATCH duyệt (chỉ đổi status, không tạo distribution) — chỉ CS1
router.patch(
    '/:id/approve',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(approveSupplyRequestSchema),
    supplyRequestController.approveSupplyRequest
);

// PATCH duyệt + cấp phát tự động (legacy, giữ lại) — chỉ CS1
router.patch(
    '/:id/approve-and-distribute',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    supplyRequestController.approveAndDistribute
);

// PATCH từ chối — chỉ CS1 (Admin/Manager)
router.patch(
    '/:id/reject',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(rejectSupplyRequestSchema),
    supplyRequestController.rejectSupplyRequest
);

export default router;
