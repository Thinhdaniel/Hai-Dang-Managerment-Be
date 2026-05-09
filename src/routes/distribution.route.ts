import { Router } from 'express';
import { authenticate, requireCS1Manager } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import validator from '@/middlewares/validator';
import * as distributionController from '@/controllers/distribution.controller';
import { confirmDistributionSchema, createDistributionRecordSchema } from '@/validations/distribution.validation';

const router = Router();

router.use(authenticate);

// Static routes first
router.get('/', distributionController.getAllDistributionRecords);
router.post('/', requireCS1Manager, validator(createDistributionRecordSchema), distributionController.createDistributionRecord);

// Sub-resource routes before /:id
router.get('/:id/export-xlsx', validateObjectId, distributionController.exportDistributionXlsx);
router.patch('/:id/distribute', requireCS1Manager, validateObjectId, distributionController.distributeDistributionRecord);
router.patch('/:id/confirm', validateObjectId, validator(confirmDistributionSchema), distributionController.confirmDistributionRecord);

// Dynamic /:id routes last
router.get('/:id', validateObjectId, distributionController.getDistributionRecordById);
router.patch('/:id', requireCS1Manager, validateObjectId, distributionController.updateDistributionRecord);

export default router;
