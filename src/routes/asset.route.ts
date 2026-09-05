import { Router } from 'express';
import { assetController } from '@/controllers';
import validator from '@/middlewares/validator';
import { createAssetSchema, updateAssetSchema } from '@/validations/asset.validation';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { validateObjectId } from '@/middlewares/objectIdValidation';
import { excelUpload } from '@/middlewares/multerMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';

const router = Router();

router.use(authenticate);

router.post('/', authorize(...ROLE_GROUPS.MANAGEMENT), validator(createAssetSchema), assetController.createAsset);
router.get('/names', assetController.getAssetNames);
router.get('/models', assetController.getAssetModels);
router.get('/types', assetController.getAssetTypes);
router.post(
    '/import/preview',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    assetController.previewAssetImportFile
);
router.post(
    '/import/confirm',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    excelUpload.single('file'),
    assetController.confirmAssetImportFile
);
router.get('/export', authorize(...ROLE_GROUPS.MANAGEMENT), assetController.exportAssets);

// Mã máy thông minh: gợi ý khi tạo (MANAGEMENT); chuẩn hoá hàng loạt mã cũ (Giám đốc trở lên).
router.post('/code/suggest', authorize(...ROLE_GROUPS.MANAGEMENT), assetController.suggestAssetCode);
router.post(
    '/code/normalize/preview',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    assetController.previewNormalizeAssetCodes
);
router.post(
    '/code/normalize/confirm',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    assetController.confirmNormalizeAssetCodes
);
// Bảng mã loại máy: xem/sửa tay/AI gợi ý (đi cùng luồng chuẩn hoá nên cùng quyền Giám đốc trở lên).
router.get('/code/type-codes', authorize(...ROLE_GROUPS.DIRECTOR_UP), assetController.listMachineTypeCodes);
router.patch('/code/type-codes', authorize(...ROLE_GROUPS.DIRECTOR_UP), assetController.saveMachineTypeCodes);
router.post(
    '/code/type-codes/ai-suggest',
    authorize(...ROLE_GROUPS.DIRECTOR_UP),
    assetController.aiSuggestMachineTypeCodes
);

router.get('/', assetController.getAllAssets);
router.patch('/:id/status', authorize(...ROLE_GROUPS.FIELD), validateObjectId, assetController.updateAssetStatus);
router.post(
    '/:id/public-id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    assetController.ensureAssetPublicId
);
router.get('/:id', validateObjectId, assetController.getAssetById);
router.patch(
    '/:id',
    authorize(...ROLE_GROUPS.MANAGEMENT),
    validateObjectId,
    validator(updateAssetSchema),
    assetController.updateAsset
);
router.delete('/:id', authorize(...ROLE_GROUPS.ADMIN_ONLY), validateObjectId, assetController.deleteAsset);

export default router;
