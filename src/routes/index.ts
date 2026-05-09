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
import materialRoutes from './material.route';
import materialSupplierRoutes from './material-supplier.route';
import purchaseRequestRoutes from './purchase-request.route';
import purchaseOrderRoutes from './purchase-order.route';
import inventoryRoutes from './inventory.route';
import distributionRoutes from './distribution.route';
import supplyRequestRoutes from './supply-request.route';
import expressDispatchRoutes from './express-dispatch.route';
import returnRecordRoutes from './return-record.route';

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
router.use('/materials', materialRoutes);
router.use('/material-suppliers', materialSupplierRoutes);
router.use('/purchase-requests', purchaseRequestRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/distributions', distributionRoutes);
router.use('/supply-requests', supplyRequestRoutes);
router.use('/express-dispatch', expressDispatchRoutes);
router.use('/return-records', returnRecordRoutes);

export default router;
