import { Router } from 'express';

import authRoutes from './auth.route';
import brandRoutes from './brand.route';
import plantRoutes from './plant.route';
import assetRoutes from './asset.route';
import userRoutes from './user.route';
import dashboardRoutes from './dashboard.route';
import maintenanceRoutes from './maintenance.route';
import transferRoutes from './transfer.route';
import borrowingRoutes from './borrowing.route';
import notificationRoutes from './notification.route';
import publicRoutes from './public.route';

const router = Router();

router.use('/auth', authRoutes);
router.use('/brands', brandRoutes);
router.use('/plants', plantRoutes);
router.use('/assets', assetRoutes);
router.use('/users', userRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/maintenances', maintenanceRoutes);
router.use('/transfers', transferRoutes);
router.use('/borrowings', borrowingRoutes);
router.use('/notifications', notificationRoutes);
router.use('/public', publicRoutes);

export default router;
