import { Router } from 'express';
import { assetController } from '@/controllers';
import validator from '@/middlewares/validator';
import { createAssetSchema, updateAssetSchema } from '@/validations/asset.validation';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { excelUpload } from '@/middlewares/multerMiddleware';
import { USER_ROLE } from '@/constant/allowedRoles';

const router = Router();

router.use(authenticate);

router.post(
    '/',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validator(createAssetSchema),
    assetController.createAsset
);
router.get('/models', assetController.getAssetModels);
router.post(
    '/import/preview',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    excelUpload.single('file'),
    assetController.previewAssetImportFile
);
router.post(
    '/import/confirm',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    excelUpload.single('file'),
    assetController.confirmAssetImportFile
);
router.get('/export', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), assetController.exportAssets);
router.get('/', assetController.getAllAssets);
router.patch(
    '/:id/status',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    assetController.updateAssetStatus
);
router.post(
    '/:id/public-id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    assetController.ensureAssetPublicId
);
router.get('/:id', validateObjectId, assetController.getAssetById);
router.patch(
    '/:id',
    authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER),
    validateObjectId,
    validator(updateAssetSchema),
    assetController.updateAsset
);
router.delete('/:id', authorize(USER_ROLE.ADMIN, USER_ROLE.MANAGER), validateObjectId, assetController.deleteAsset);

export default router;
