import { Router } from 'express';
import { plantController } from '@/controllers';
import validator from '@/middlewares/validator';
import { createPlantSchema, updatePlantSchema } from '@/validations/plant.validation';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { USER_ROLE } from '@/constant/allowedRoles';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(createPlantSchema),
    plantController.createPlant
);
router.get('/', plantController.getAllPlants);
router.get('/with-machine-count', plantController.getPlantsWithMachineCount);
router.get('/:id', validateObjectId, plantController.getPlantById);
router.patch(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(updatePlantSchema),
    plantController.updatePlant
);
router.delete('/:id', authorize(USER_ROLE.ADMIN), validateObjectId, plantController.deletePlant);

export default router;
