import { Router } from 'express';
import { assetController } from '@/controllers';

const router = Router();

router.get('/machines/:publicId', assetController.getPublicAssetByPublicId);

export default router;
