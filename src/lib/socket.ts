import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { allowedOrigins } from '@/constant/allowOrigins';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '@/config/env.config';
import { tokenTypes } from '@/constant/token';
import User from '@/models/User';
import UserSession from '@/models/UserSession';

interface AuthPayload extends JwtPayload {
    userId: string;
    role: string;
    sessionId: string;
    type: string;
}

let io: SocketServer | null = null;

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
    io.use(async (socket: Socket, next) => {
        try {
            const token = socket.handshake.auth?.token as string | undefined;

            // Allow unauthenticated connections when AUTH_BYPASS is enabled (dev only)
            if (config.auth.bypass && !token) {
                socket.data.userId = '000000000000000000000000';
                socket.data.role = 'admin';
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

        console.log(`[Socket.io] Client connected: ${socket.id} (user: ${userId})`);

        socket.on('disconnect', (reason) => {
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
