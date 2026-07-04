import { Router } from 'express';
import asyncHandler from '@/utils/asyncHandler';
import { authenticate } from '@/middlewares/authenticationMiddleware';
import { authorize } from '@/middlewares/authorizationMiddleware';
import { ROLE_GROUPS } from '@/constant/permissions';
import { getFloorMap, saveFloorZones, saveFloorPositions } from '@/services/floor-map.service';

const router = Router();

router.use(authenticate);

// Xem sơ đồ: mọi người dùng đã đăng nhập. Thiết lập (khu vực + vị trí máy): Giám đốc trở lên.
router.get('/', asyncHandler(getFloorMap));
router.put('/zones', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(saveFloorZones));
router.patch('/positions', authorize(...ROLE_GROUPS.DIRECTOR_UP), asyncHandler(saveFloorPositions));

export default router;
