import { Router } from 'express';
import { authenticate, requireCS1Director } from '@/middlewares/authenticationMiddleware';
import validator from '@/middlewares/validator';
import { expressDispatchSchema } from '@/validations/express-dispatch.validation';
import * as ctrl from '@/controllers/express-dispatch.controller';

const router = Router();

router.use(authenticate, requireCS1Director);

router.post('/', validator(expressDispatchSchema), ctrl.expressDispatch);

export default router;
