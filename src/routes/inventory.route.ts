import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import { USER_ROLE } from '@/constant/allowedRoles';
import * as inventoryController from '@/controllers/inventory.controller';
import { adjustInventorySchema, overrideInventorySchema } from '@/validations/inventory.validation';
import { excelUpload } from '@/middlewares/multerMiddleware';

const router = Router();

router.use(authenticate);

// ── New routes (must be before /:materialId) ──────────────────────────────
router.get('/import-template', inventoryController.downloadTemplate);
router.post(
    '/import-preview',
    authorize(USER_ROLE.ADMIN),
    excelUpload.single('file'),
    inventoryController.previewInventoryImport
);
router.post(
    '/import-excel',
    authorize(USER_ROLE.ADMIN),
    excelUpload.single('file'),
    inventoryController.importExcel
);
router.post('/initialize', authorize(USER_ROLE.ADMIN), inventoryController.initializeStock);
router.get('/export-excel', inventoryController.exportExcel);

// ── Existing routes ───────────────────────────────────────────────────────
router.get('/transactions', inventoryController.getInventoryTransactions);
router.post('/adjust', authorize(USER_ROLE.ADMIN), validator(adjustInventorySchema), inventoryController.adjustInventory);
router.put('/adjust', authorize(USER_ROLE.ADMIN), validator(overrideInventorySchema), inventoryController.overrideInventoryStock);
router.get('/', inventoryController.getInventoryStocks);
router.get('/:materialId', validateObjectId, inventoryController.getInventoryByMaterial);

export default router;
