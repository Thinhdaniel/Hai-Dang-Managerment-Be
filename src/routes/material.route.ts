import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { excelUpload } from '@/middlewares/multerMiddleware';
import { USER_ROLE } from '@/constant/allowedRoles';
import * as materialController from '@/controllers/material.controller';
import { createMaterialSchema, updateMaterialSchema } from '@/validations/material.validation';

const router = Router();
const upload = excelUpload;

router.use(authenticate);

router.get(
    '/reports/summary',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.getMaterialReportsSummary
);
router.get(
    '/reports/cost-by-period',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.getMaterialCostByPeriodReport
);
router.get(
    '/reports/by-supplier',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.getMaterialReportBySupplier
);
router.get(
    '/reports/price-comparison',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.getMaterialPriceComparisonReport
);
router.get(
    '/reports/top-materials',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.getTopMaterials
);
router.get(
    '/reports/distribution-cost',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.getDistributionCostReport
);
router.get(
    '/reports/export-excel',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    materialController.exportMaterialReportExcel
);
router.get('/low-stock', materialController.getLowStockMaterials);
router.get('/export-excel', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), materialController.exportMaterialCatalogExcel);
router.get('/import-template', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), materialController.downloadMaterialImportTemplate);
router.post('/import/preview', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), upload.single('file'), materialController.previewMaterialImport);
router.post('/import/confirm', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), upload.single('file'), materialController.confirmMaterialImport);
router.post('/', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), validator(createMaterialSchema), materialController.createMaterial);
router.get('/', materialController.getAllMaterials);
router.get('/:id', validateObjectId, materialController.getMaterialById);
router.put(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(updateMaterialSchema),
    materialController.updateMaterial
);
router.delete('/:id', authorize(USER_ROLE.ADMIN), validateObjectId, materialController.deleteMaterial);

export default router;
