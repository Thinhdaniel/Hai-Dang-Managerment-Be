import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as inventoryController from '@/controllers/inventory.controller';
import { adjustInventorySchema, overrideInventorySchema } from '@/validations/inventory.validation';
import { excelUpload } from '@/middlewares/multerMiddleware';

const router = Router();

router.use(authenticate);

// Tồn kho chỉ dành cho cấp quản lý trở lên (Bộ phận kỹ thuật không xem).
router.use(authorize(...ROLE_GROUPS.MANAGEMENT));

// ── New routes (must be before /:materialId) ──────────────────────────────
router.get('/import-template', inventoryController.downloadTemplate);
router.post(
    '/import-preview',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    excelUpload.single('file'),
    inventoryController.previewInventoryImport
);
router.post(
    '/import-excel',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    excelUpload.single('file'),
    inventoryController.importExcel
);
router.post('/initialize', authorize(...ROLE_GROUPS.ADMIN_ONLY), inventoryController.initializeStock);
router.get('/export-excel', inventoryController.exportExcel);

// ── Existing routes ───────────────────────────────────────────────────────
router.get('/transactions', inventoryController.getInventoryTransactions);
router.post('/adjust', authorize(...ROLE_GROUPS.ADMIN_ONLY), validator(adjustInventorySchema), inventoryController.adjustInventory);
router.put('/adjust', authorize(...ROLE_GROUPS.ADMIN_ONLY), validator(overrideInventorySchema), inventoryController.overrideInventoryStock);
router.get('/', inventoryController.getInventoryStocks);
router.get('/:materialId', validateObjectId, inventoryController.getInventoryByMaterial);

export default router;
