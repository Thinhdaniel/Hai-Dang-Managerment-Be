import { Router } from 'express';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import * as supplyShortageController from '@/controllers/supply-shortage.controller';

const router = Router();

router.use(authenticate);

router.get('/', supplyShortageController.getAllSupplyShortages);
router.get('/:id', validateObjectId, supplyShortageController.getSupplyShortageById);

export default router;
