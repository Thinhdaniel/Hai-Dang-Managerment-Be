import { ROLE_GROUPS } from '@/constant/permissions';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import validator from '@/middlewares/validator';
import * as stocktakeService from '@/services/stocktake.service';
import asyncHandler from '@/utils/asyncHandler';
import {
    createStocktakeSessionSchema,
    reviewStocktakePositionProposalsSchema,
    createStocktakeDriftProposalSchema,
} from '@/validations/stocktake.validation';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { Router } from 'express';

const router = Router();

router.use(authenticate);
router.use(authorize(...ROLE_GROUPS.FIELD));

router.post('/', validator(createStocktakeSessionSchema), asyncHandler(stocktakeService.createStocktakeSession));
router.get('/', asyncHandler(stocktakeService.getStocktakeSessions));
router.post(
    '/:id/position-proposals/from-drift',
    validateObjectId,
    validator(createStocktakeDriftProposalSchema),
    asyncHandler(stocktakeService.createStocktakeDriftProposal)
);
router.patch(
    '/:id/position-proposals/review',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    validateObjectId,
    validator(reviewStocktakePositionProposalsSchema),
    asyncHandler(stocktakeService.reviewStocktakePositionProposals)
);

export default router;
