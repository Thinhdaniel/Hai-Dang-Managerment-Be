import { Router } from 'express';
import { assetController } from '@/controllers';
import { qrLabelController } from '@/controllers';

const router = Router();

router.get('/qr/:publicId', qrLabelController.resolvePublicQr);
router.get('/machines/:publicId', assetController.getPublicAssetByPublicId);

export default router;
