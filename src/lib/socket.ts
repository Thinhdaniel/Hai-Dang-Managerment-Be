import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { allowedOrigins } from '@/constant/allowOrigins';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '@/config/env.config';
import { tokenTypes } from '@/constant/token';
import User from '@/models/User';
import UserSession from '@/models/UserSession';
import ChatConversation from '@/models/ChatConversation';
import mongoose from 'mongoose';

interface AuthPayload extends JwtPayload {
    userId: string;
    role: string;
    sessionId: string;
    type: string;
}

let io: SocketServer | null = null;

// Đếm số kết nối còn sống của từng user (1 người có thể mở nhiều tab/thiết bị) để suy ra online/offline.
const onlineCounts = new Map<string, number>();

export const getOnlineUserIds = (): string[] => Array.from(onlineCounts.keys());

export const initSocketServer = (httpServer: HttpServer): SocketServer => {
    io = new SocketServer(httpServer, {
        cors: {
            origin: allowedOrigins,
            credentials: true,
            methods: ['GET', 'POST'],
        },
        transports: ['websocket', 'polling'],
    });

    // ── Authentication middleware ──────────────────────────────────────────
    io.use(async (socket: Socket, next: (err?: Error) => void) => {
        try {
            const token = socket.handshake.auth?.token as string | undefined;

            // Allow unauthenticated connections when AUTH_BYPASS is enabled (dev only)
            if (config.auth.bypass && !token) {
                socket.data.userId = '000000000000000000000000';
                socket.data.role = 'admin';
                socket.data.name = 'Admin';
                return next();
            }

            if (!token) {
                return next(new Error('Authentication required'));
            }

            const decoded = jwt.verify(token, config.jwt.accessTokenKey) as AuthPayload;

            if (!decoded || decoded.type !== tokenTypes.ACCESS || !decoded.sessionId) {
                return next(new Error('Invalid token'));
            }

            const [session, user] = await Promise.all([
                UserSession.findOne({
                    _id: decoded.sessionId,
                    userId: decoded.userId,
                    revoked: { $ne: true },
                    expireAt: { $gt: new Date() },
                }),
                User.findOne({ _id: decoded.userId, isDeleted: { $ne: true } }),
            ]);

            if (!session || !user || !user.isActive) {
                return next(new Error('Invalid or expired session'));
            }

            socket.data.userId = String(user._id);
            socket.data.role = user.role;
            socket.data.name = user.fullname || user.username || user.email || 'Người dùng';
            next();
        } catch (err: any) {
            next(new Error('Authentication failed'));
        }
    });

    // ── Connection handler ────────────────────────────────────────────────
    io.on('connection', (socket: Socket) => {
        const userId = socket.data.userId as string;

        // Join a user-specific room so we can target notifications
        void socket.join(`user:${userId}`);

        // ── Presence: cập nhật online/offline ──────────────────────────────
        const prevCount = onlineCounts.get(userId) ?? 0;
        onlineCounts.set(userId, prevCount + 1);
        // Gửi ảnh chụp danh sách đang online cho client vừa kết nối
        socket.emit('chat:presence:init', { userIds: Array.from(onlineCounts.keys()) });
        // Báo cho mọi người nếu user này vừa chuyển từ offline -> online
        if (prevCount === 0) {
            io?.emit('chat:presence', { userId, online: true });
        }

        console.log(`[Socket.io] Client connected: ${socket.id} (user: ${userId})`);

        // Relay "đang soạn tin" tới các thành viên khác của hội thoại (không lưu DB).
        // Client tự throttle; bên nhận tự ẩn sau ~3s nếu không có ping mới.
        socket.on('chat:typing', async (payload: { conversationId?: string } = {}) => {
            try {
                const conversationId = String(payload?.conversationId || '');
                if (!mongoose.isValidObjectId(conversationId)) return;

                const conversation = await ChatConversation.findById(conversationId).select('participantIds').lean();
                if (!conversation) return;

                const participantIds = (conversation.participantIds ?? []).map(String);
                if (!participantIds.includes(userId)) return;

                const name = (socket.data.name as string) || 'Người dùng';
                participantIds
                    .filter((id) => id && id !== userId)
                    .forEach((id) => {
                        io?.to(`user:${id}`).emit('chat:typing', { conversationId, userId, name });
                    });
            } catch {
                // Typing là tín hiệu phù du, lỗi thì bỏ qua
            }
        });

        // Client xin lại ảnh chụp danh sách online (phòng trường hợp lỡ sự kiện init lúc kết nối)
        socket.on('chat:presence:sync', () => {
            socket.emit('chat:presence:init', { userIds: Array.from(onlineCounts.keys()) });
        });

        socket.on('disconnect', (reason: string) => {
            const current = onlineCounts.get(userId) ?? 0;
            if (current <= 1) {
                onlineCounts.delete(userId);
                io?.emit('chat:presence', { userId, online: false });
            } else {
                onlineCounts.set(userId, current - 1);
            }
            console.log(`[Socket.io] Client disconnected: ${socket.id} — ${reason}`);
        });
    });

    console.log('[Socket.io] Server initialized');
    return io;
};

/**
 * Emit an event to a specific user's room.
 * Falls back gracefully if the socket server hasn't been initialized yet.
 */
export const emitToUser = (userId: string, event: string, data: unknown): void => {
    if (!io) {
        console.warn('[Socket.io] emitToUser called before server initialization');
        return;
    }
    io.to(`user:${userId}`).emit(event, data);
};

/**
 * Broadcast an event to ALL connected clients.
 */
export const emitToAll = (event: string, data: unknown): void => {
    if (!io) {
        console.warn('[Socket.io] emitToAll called before server initialization');
        return;
    }
    io.emit(event, data);
};

export const getSocketServer = (): SocketServer | null => io;
