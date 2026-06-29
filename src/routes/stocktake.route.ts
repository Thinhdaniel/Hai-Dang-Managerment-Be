import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import * as stocktakeService from '@/services/stocktake.service';
import asyncHandler from '@/utils/asyncHandler';
import { createStocktakeSessionSchema } from '@/validations/stocktake.validation';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.FIELD));

router.post('/', validator(createStocktakeSessionSchema), asyncHandler(stocktakeService.createStocktakeSession));
router.get('/', asyncHandler(stocktakeService.getStocktakeSessions));

export default router;
