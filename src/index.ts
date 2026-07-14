import http from 'http';
import app from './app';
import connectDB from './config/database.config';
import config from './config/env.config';
import { checkAndNotifyOverdueMaintenance } from './services/notification.helper';
import { startAuditSchedule } from './services/audit.service';
import { initSocketServer } from './lib/socket';
import { startRealityOperationsSchedule } from './services/reality-operations.service';

const PORT = config.port || 8080;
const HOSTNAME = config.hostname;

const server = http.createServer(app);

// Initialize Socket.io BEFORE listening
initSocketServer(server);

connectDB().then(async () => {
    server.listen(PORT, HOSTNAME, () => {
        console.log(`Listening to port ${PORT}`);
    });

    // Check overdue maintenance every hour
    setInterval(
        async () => {
            await checkAndNotifyOverdueMaintenance();
        },
        60 * 60 * 1000
    ); // 1 hour

    // Also run immediately on startup
    await checkAndNotifyOverdueMaintenance();

    // Kiểm toán đêm 03:30: rule-check + AI săn bất thường toàn hệ thống.
    startAuditSchedule();

    // Snapshot + cảnh báo Reality Health mỗi ngày; production sleep dùng thêm internal route/UptimeRobot.
    startRealityOperationsSchedule();
});

const exitHandler = () => {
    if (server) {
        server.close(async () => {
            console.log('Server closed');
            process.exit(1);
        });
    } else {
        process.exit(1);
    }
};

const unexpectedErrorHandler = (error: string) => {
    console.log(error);
    exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', async () => {
    console.log('SIGTERM received');
    if (server) {
        server.close();
    }
});
