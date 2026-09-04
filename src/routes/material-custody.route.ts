import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { excelUpload } from '@/middlewares/multerMiddleware';
import { validateObjectIdParams } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as materialCustodyService from '@/services/material-custody.service';
import asyncHandler from '@/utils/asyncHandler';
import {
    createMaterialRecipientSchema,
    createMaterialCustodyOpeningBalanceSchema,
    createMaterialUsageCampaignSchema,
    openMaterialRecallSchema,
    reissueReusableMaterialSchema,
    resolveMaterialCustodySchema,
    transferMaterialCustodySchema,
    updateMaterialRecipientSchema,
} from '@/validations/material-custody.validation';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.MANAGEMENT));

router.get('/summary', asyncHandler(materialCustodyService.getSummary));
router.get('/export', asyncHandler(materialCustodyService.exportMaterialCustodyReport));
router.get('/reusable-stock', asyncHandler(materialCustodyService.listReusableStock));
router.get('/references/production-items', asyncHandler(materialCustodyService.listProductionItemReferences));
router.get('/references/materials', asyncHandler(materialCustodyService.listTrackedMaterialReferences));

router.get('/recipients', asyncHandler(materialCustodyService.listRecipients));
router.get('/recipients/import-template', asyncHandler(materialCustodyService.downloadRecipientImportTemplate));
router.post(
    '/recipients/import/preview',
    excelUpload.single('file'),
    asyncHandler(materialCustodyService.previewRecipientImport)
);
router.post(
    '/recipients/import/confirm',
    excelUpload.single('file'),
    asyncHandler(materialCustodyService.confirmRecipientImport)
);
router.post(
    '/recipients',
    validator(createMaterialRecipientSchema),
    asyncHandler(materialCustodyService.createRecipient)
);
router.patch(
    '/recipients/:id',
    validateObjectIdParams('id'),
    validator(updateMaterialRecipientSchema),
    asyncHandler(materialCustodyService.updateRecipient)
);

router.get('/campaigns', asyncHandler(materialCustodyService.listCampaigns));
router.post(
    '/campaigns',
    validator(createMaterialUsageCampaignSchema),
    asyncHandler(materialCustodyService.createCampaign)
);
router.post(
    '/campaigns/:id/open-recall',
    validateObjectIdParams('id'),
    validator(openMaterialRecallSchema),
    asyncHandler(materialCustodyService.openRecall)
);
router.post('/campaigns/:id/close', validateObjectIdParams('id'), asyncHandler(materialCustodyService.closeCampaign));

router.get('/assignments', asyncHandler(materialCustodyService.listAssignments));
router.post(
    '/assignments/opening-balance',
    validator(createMaterialCustodyOpeningBalanceSchema),
    asyncHandler(materialCustodyService.createOpeningBalanceAssignment)
);
router.get(
    '/assignments/:id/movements',
    validateObjectIdParams('id'),
    asyncHandler(materialCustodyService.getAssignmentMovements)
);
router.post(
    '/assignments/:id/resolve',
    validateObjectIdParams('id'),
    validator(resolveMaterialCustodySchema),
    asyncHandler(materialCustodyService.resolveAssignment)
);
router.post(
    '/assignments/:id/transfer',
    validateObjectIdParams('id'),
    validator(transferMaterialCustodySchema),
    asyncHandler(materialCustodyService.transferAssignment)
);
router.post('/reissue', validator(reissueReusableMaterialSchema), asyncHandler(materialCustodyService.reissueReusable));

export default router;
