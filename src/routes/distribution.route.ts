import { Router } from 'express';
import { authenticate, requireCS1Manager, requirePlantManager } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as distributionController from '@/controllers/distribution.controller';
import {
    confirmDistributionSchema,
    createCompensationDistributionRecordSchema,
    createDistributionRecordSchema,
    createInternalDistributionRecordSchema,
    createInternalDraftSchema,
    appendInternalItemsSchema,
    finalizeInternalDraftSchema,
} from '@/validations/distribution.validation';

const router = Router();

router.use(authenticate);

// Static routes first
router.get('/', distributionController.getAllDistributionRecords);
router.get('/export-range-xlsx', distributionController.exportRangeDistributionXlsx);
router.post('/', requireCS1Manager, validator(createDistributionRecordSchema), distributionController.createDistributionRecord);
router.post('/compensations', requireCS1Manager, validator(createCompensationDistributionRecordSchema), distributionController.createCompensationDistributionRecord);
router.post('/internal', requirePlantManager, validator(createInternalDraftSchema), distributionController.createInternalDistributionRecord);
router.post('/:id/internal/items', requirePlantManager, validateObjectId, validator(appendInternalItemsSchema), distributionController.appendInternalItems);
router.patch('/:id/internal/finalize', requirePlantManager, validateObjectId, validator(finalizeInternalDraftSchema), distributionController.finalizeInternalDraft);

// Sub-resource routes before /:id
router.get('/:id/export-xlsx', validateObjectId, distributionController.exportDistributionXlsx);
router.patch('/:id/distribute', requireCS1Manager, validateObjectId, distributionController.distributeDistributionRecord);
router.patch('/:id/confirm', requirePlantManager, validateObjectId, validator(confirmDistributionSchema), distributionController.confirmDistributionRecord);

// Dynamic /:id routes last
router.get('/:id', validateObjectId, distributionController.getDistributionRecordById);
router.patch('/:id', requireCS1Manager, validateObjectId, distributionController.updateDistributionRecord);

export default router;
