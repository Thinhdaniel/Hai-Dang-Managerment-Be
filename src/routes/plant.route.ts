import { Router } from 'express';
import { plantController } from '@/controllers';
import validator from '@/middlewares/validator';
import { createPlantSchema, updatePlantSchema } from '@/validations/plant.validation';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validator(createPlantSchema),
    plantController.createPlant
);
router.get('/', plantController.getAllPlants);
router.get('/with-machine-count', plantController.getPlantsWithMachineCount);
router.get('/:id', validateObjectId, plantController.getPlantById);
router.patch(
    '/:id',
    authorize(...ROLE_GROUPS.ADMIN_ONLY),
    validateObjectId,
    validator(updatePlantSchema),
    plantController.updatePlant
);
router.delete('/:id', authorize(...ROLE_GROUPS.ADMIN_ONLY), validateObjectId, plantController.deletePlant);

export default router;
