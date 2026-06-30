import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { excelUpload } from '@/middlewares/multerMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import * as materialController from '@/controllers/material.controller';
import { createMaterialSchema, updateMaterialSchema } from '@/validations/material.validation';

const router = Router();
const upload = excelUpload;

router.use(authenticate);

router.get('/reports/summary', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.getMaterialReportsSummary);
router.get(
    '/reports/cost-by-period',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    materialController.getMaterialCostByPeriodReport
);
router.get('/reports/by-supplier', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.getMaterialReportBySupplier);
router.get(
    '/reports/price-comparison',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    materialController.getMaterialPriceComparisonReport
);
router.get('/reports/top-materials', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.getTopMaterials);
router.get(
    '/reports/distribution-cost',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    materialController.getDistributionCostReport
);
router.get(
    '/reports/cost-flow-by-plant',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    materialController.getMaterialCostFlowByPlantReport
);
router.get('/reports/export-excel', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.exportMaterialReportExcel);
router.get('/low-stock', materialController.getLowStockMaterials);
router.get('/export-excel', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.exportMaterialCatalogExcel);
router.get('/import-template', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.downloadMaterialImportTemplate);
router.post('/import/preview', authorize(...ROLE_GROUPS.MANAGEMENT), upload.single('file'), materialController.previewMaterialImport);
router.post('/import/confirm', authorize(...ROLE_GROUPS.MANAGEMENT), upload.single('file'), materialController.confirmMaterialImport);
router.post('/cost-type/suggest', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.suggestMaterialCostTypes);
router.patch('/cost-type', authorize(...ROLE_GROUPS.MANAGEMENT), materialController.saveMaterialCostTypes);
router.post('/', authorize(...ROLE_GROUPS.MANAGEMENT), validator(createMaterialSchema), materialController.createMaterial);
router.get('/', materialController.getAllMaterials);
router.get('/:id', validateObjectId, materialController.getMaterialById);
router.put(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateMaterialSchema),
    materialController.updateMaterial
);
router.delete('/:id', authorize(...ROLE_GROUPS.ADMIN_ONLY), validateObjectId, materialController.deleteMaterial);

export default router;
