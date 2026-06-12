import { USER_ROLE } from '@/constant/allowedRoles';
import cloudinaryConfig from '@/config/cloudinary.config';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToUser } from '@/lib/socket';
import ChatConversation, { type IChatConversation } from '@/models/ChatConversation';
import ChatMessage, { type IChatAttachment, type IChatMessage } from '@/models/ChatMessage';
import Maintenance from '@/models/Maintenance';
import User from '@/models/User';
import { getUserPlantId, isManagerRole, toId } from '@/services/material-workflow.helpers';
import { sendWebPushToUser } from '@/services/web-push.service';
import customResponse from '@/utils/response';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import streamifier from 'streamifier';

const MAX_CHAT_USERS = 30;
const MAX_CONVERSATION_PARTICIPANTS = 25;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_CHAT_ATTACHMENTS = 4;
const CONTEXT_TYPES = ['maintenance'] as const;

cloudinary.config(cloudinaryConfig);

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeIds = (ids: unknown[], excludeId?: string) =>
    Array.from(
        new Set(
            ids
                .map((id) => String(id ?? '').trim())
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
                .filter((id) => !excludeId || id !== excludeId)
        )
    );

const getUserDisplayName = (user: any) => user?.fullname || user?.name || user?.username || user?.email || 'Người dùng';

const buildMaintenanceCode = (maintenance: any) => {
    const baseDate = maintenance?.createdAt || maintenance?.startDate || new Date();
    const year = new Date(baseDate).getFullYear();
    return `MNT-${year}-${String(maintenance?._id ?? maintenance?.id ?? '').slice(-5).toUpperCase()}`;
};

const getPlantSummary = (plant: any) => {
    if (!plant || typeof plant !== 'object') return undefined;

    return {
        id: toId(plant),
        name: plant.name,
        code: plant.code,
    };
};

const serializeChatUser = (user: any) => {
    const plant = user?.plantId && typeof user.plantId === 'object' ? getPlantSummary(user.plantId) : undefined;

    return {
        id: toId(user),
        name: getUserDisplayName(user),
        email: user?.email,
        role: user?.role,
        plantId: plant?.id ?? toId(user?.plantId),
        plant,
        avatarUrl: user?.avatarUrl,
        isActive: user?.isActive !== false,
    };
};

const getParticipantState = (conversation: IChatConversation | any, userId: string) =>
    (conversation.participantStates ?? []).find((state: any) => String(state.userId?._id ?? state.userId) === userId);

const getConversationTitle = (conversation: IChatConversation | any, currentUserId: string) => {
    if (conversation.title) return conversation.title;

    const participants = Array.isArray(conversation.participantIds) ? conversation.participantIds : [];
    const otherNames = participants
        .filter((user: any) => toId(user) !== currentUserId)
        .map(getUserDisplayName)
        .filter(Boolean);

    if (otherNames.length) {
        return otherNames.slice(0, 3).join(', ') + (otherNames.length > 3 ? ` +${otherNames.length - 3}` : '');
    }

    return 'Tin nhắn nội bộ';
};

const serializeConversation = (conversation: IChatConversation | any, currentUserId: string) => {
    const state = getParticipantState(conversation, currentUserId);
    const plant = conversation?.plantId && typeof conversation.plantId === 'object' ? getPlantSummary(conversation.plantId) : undefined;

    return {
        id: toId(conversation),
        type: conversation.type,
        title: getConversationTitle(conversation, currentUserId),
        plantId: plant?.id ?? toId(conversation?.plantId),
        plant,
        context: conversation.context,
        participants: Array.isArray(conversation.participantIds)
            ? conversation.participantIds.map(serializeChatUser).filter((user: any) => user.id)
            : [],
        lastMessagePreview: conversation.lastMessagePreview,
        lastMessageAt: conversation.lastMessageAt,
        lastMessageSenderId: toId(conversation.lastMessageSenderId),
        unreadCount: Number(state?.unreadCount ?? 0),
        muted: state?.muted === true,
        archivedAt: state?.archivedAt ?? undefined,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
    };
};

const serializeMessage = (message: IChatMessage | any) => ({
    id: toId(message),
    conversationId: toId(message.conversationId),
    senderId: toId(message.senderId),
    sender: message.senderId && typeof message.senderId === 'object' ? serializeChatUser(message.senderId) : undefined,
    body: message.isDeleted ? 'Tin nhắn đã được thu hồi' : message.body,
    attachments: message.isDeleted ? [] : (message.attachments ?? []),
    system: message.system === true,
    isDeleted: message.isDeleted === true,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
});

const getMessagePreview = (body: string, attachments: IChatAttachment[] = []) => {
    if (body) return body.slice(0, 500);
    if (attachments.length) return attachments.length > 1 ? `Đã gửi ${attachments.length} ảnh` : 'Đã gửi 1 ảnh';
    return '';
};

const populateConversation = (query: any) =>
    query
        .populate({
            path: 'participantIds',
            select: 'fullname username email role avatarUrl plantId isActive',
            populate: { path: 'plantId', select: 'name code' },
        })
        .populate({ path: 'plantId', select: 'name code' });

const populateMessage = (query: any) =>
    query.populate({
        path: 'senderId',
        select: 'fullname username email role avatarUrl plantId isActive',
        populate: { path: 'plantId', select: 'name code' },
    });

const getVisibleUserFilter = (req: Request, includeSelf = false) => {
    const base: Record<string, any> = {
        isDeleted: { $ne: true },
        isActive: true,
    };

    if (!includeSelf && req.userId && mongoose.Types.ObjectId.isValid(req.userId)) {
        base._id = { $ne: toObjectId(req.userId) };
    }

    if (isManagerRole(req.role)) {
        return base;
    }

    const plantId = getUserPlantId(req);
    const scope: Record<string, any>[] = [{ role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER] } }];

    if (plantId && mongoose.Types.ObjectId.isValid(plantId)) {
        scope.unshift({ plantId: toObjectId(plantId) });
    }

    return {
        ...base,
        $or: scope,
    };
};

const ensureConversationMember = async (conversationId: string, userId?: string) => {
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        throw new UnAuthorizedError('Phien dang nhap khong hop le');
    }

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        throw new NotFoundError('Khong tim thay hoi thoai');
    }

    const conversation = await ChatConversation.findOne({
        _id: conversationId,
        isDeleted: { $ne: true },
        participantIds: toObjectId(userId),
    });

    if (!conversation) {
        throw new NotFoundError('Khong tim thay hoi thoai');
    }

    return conversation;
};

const getTotalUnreadForUser = async (userId: string) => {
    const rows = await ChatConversation.aggregate<{ total: number }>([
        {
            $match: {
                isDeleted: { $ne: true },
                participantIds: toObjectId(userId),
            },
        },
        { $unwind: '$participantStates' },
        { $match: { 'participantStates.userId': toObjectId(userId) } },
        { $group: { _id: null, total: { $sum: '$participantStates.unreadCount' } } },
    ]);

    return rows[0]?.total ?? 0;
};

const assertReachableUsers = async (req: Request, targetIds: string[]) => {
    if (!targetIds.length) return [];

    const users = await User.find({
        ...getVisibleUserFilter(req, true),
        _id: { $in: targetIds.map(toObjectId) },
    })
        .populate('plantId', 'name code')
        .select('fullname username email role avatarUrl plantId isActive')
        .lean();

    if (users.length !== targetIds.length) {
        throw new UnAuthorizedError('Co nguoi dung khong nam trong pham vi trao doi cua ban');
    }

    return users;
};

const emitConversationSnapshot = async (conversation: IChatConversation, message?: any) => {
    const populatedConversation = await populateConversation(ChatConversation.findById(conversation._id));
    if (!populatedConversation) return;

    const participantStates = populatedConversation.participantStates ?? [];

    await Promise.all(
        populatedConversation.participantIds.map(async (participant: any) => {
            const participantId = toId(participant);
            if (!participantId) return;

            emitToUser(participantId, 'chat:conversation:update', {
                conversation: serializeConversation(populatedConversation, participantId),
                totalUnread: await getTotalUnreadForUser(participantId),
            });

            if (message) {
                const state = participantStates.find((item: any) => String(item.userId) === participantId);
                const preview = getMessagePreview(message.body ?? '', message.attachments ?? []);
                emitToUser(participantId, 'chat:message:new', {
                    conversation: serializeConversation(populatedConversation, participantId),
                    message: serializeMessage(message),
                    totalUnread: await getTotalUnreadForUser(participantId),
                });

                if (participantId !== toId(message.senderId) && state?.muted !== true) {
                    void sendWebPushToUser(participantId, {
                        _id: message._id,
                        title: 'Tin nhắn nội bộ',
                        message: `${getUserDisplayName(message.senderId)}: ${preview.slice(0, 120)}`,
                        type: 'info',
                        actionType: 'chat',
                        actionId: String(populatedConversation._id),
                        isRead: false,
                        createdAt: message.createdAt,
                    });
                }
            }
        })
    );
};

const uploadChatImage = (file: Express.Multer.File): Promise<IChatAttachment> =>
    new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: 'hai-dang/chat',
                resource_type: 'image',
                tags: ['chat', 'maintenance'],
            },
            (error, result?: UploadApiResponse) => {
                if (error || !result) {
                    reject(error || new Error('Upload anh that bai'));
                    return;
                }

                resolve({
                    type: 'image',
                    url: result.secure_url,
                    publicId: result.public_id,
                    name: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                    width: result.width,
                    height: result.height,
                });
            }
        );

        streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });

const resolveMaintenanceContext = async (maintenanceId: string, req?: Request) => {
    if (!mongoose.Types.ObjectId.isValid(maintenanceId)) {
        throw new NotFoundError('Khong tim thay phieu bao tri');
    }

    const maintenance = await Maintenance.findOne({ _id: maintenanceId, isDeleted: { $ne: true } })
        .populate({
            path: 'assetId',
            populate: [
                { path: 'brandId' },
                { path: 'plantId', select: 'name code' },
            ],
        })
        .populate('plantId', 'name code')
        .populate('createdBy', 'fullname username email role avatarUrl plantId isActive')
        .lean();

    if (!maintenance) {
        throw new NotFoundError('Khong tim thay phieu bao tri');
    }

    const asset = (maintenance as any).assetId;
    const plantId = toId((maintenance as any).plantId) ?? toId(asset?.plantId);
    const currentUserPlantId = req ? getUserPlantId(req) : undefined;
    const currentUserId = req?.userId;
    const isCreator = currentUserId && toId((maintenance as any).createdBy) === currentUserId;
    const samePlant = Boolean(plantId && currentUserPlantId && plantId === currentUserPlantId);

    if (req && !isManagerRole(req.role) && !isCreator && !samePlant) {
        throw new UnAuthorizedError('Ban khong co quyen trao doi tren phieu bao tri nay');
    }

    const code = buildMaintenanceCode(maintenance);
    const assetName = asset?.name || 'Máy chưa xác định';
    const machineCode = asset?.machineCode;

    return {
        maintenance,
        asset,
        plantId,
        code,
        title: `Bảo trì ${machineCode || assetName}`,
        label: `${code} · ${assetName}`,
        path: `/maintenances?maintenance=${maintenanceId}`,
    };
};

const getMaintenanceParticipantIds = async (maintenanceContext: Awaited<ReturnType<typeof resolveMaintenanceContext>>, actorId?: string) => {
    const participantIds = normalizeIds(
        [
            actorId,
            toId((maintenanceContext.maintenance as any).createdBy),
        ],
        undefined
    );

    const managementFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        isActive: true,
        role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER] },
    };

    const managementUsers = await User.find(managementFilter)
        .select('_id role plantId')
        .lean();

    for (const manager of managementUsers) {
        const managerId = toId(manager);
        if (!managerId) continue;

        const managerRole = String((manager as any).role);
        const managerPlantId = toId((manager as any).plantId);
        const shouldInclude =
            managerRole === USER_ROLE.ADMIN ||
            managerRole === USER_ROLE.DIRECTOR ||
            !maintenanceContext.plantId ||
            managerPlantId === maintenanceContext.plantId;

        if (shouldInclude) {
            participantIds.push(managerId);
        }
    }

    return Array.from(new Set(participantIds)).slice(0, MAX_CONVERSATION_PARTICIPANTS);
};

// Ghi lastMessage + unreadCount bằng update atomic ($inc) để 2 tin nhắn gửi
// gần như đồng thời vào cùng hội thoại không ghi đè count của nhau.
const applyMessageToConversation = async (
    conversation: IChatConversation,
    message: IChatMessage,
    senderId: string,
    preview: string,
    now: Date
) => {
    const senderObjectId = toObjectId(senderId);

    const knownStateIds = new Set((conversation.participantStates ?? []).map((state) => String(state.userId)));
    const missingStates = conversation.participantIds
        .filter((participantId) => !knownStateIds.has(String(participantId)))
        .map((participantId) => ({ userId: participantId, unreadCount: 0, muted: false }));

    if (missingStates.length) {
        await ChatConversation.updateOne(
            { _id: conversation._id },
            { $push: { participantStates: { $each: missingStates } } }
        );
    }

    await ChatConversation.updateOne(
        { _id: conversation._id },
        {
            $set: {
                lastMessageId: message._id,
                lastMessageSenderId: senderObjectId,
                lastMessagePreview: preview,
                lastMessageAt: now,
                'participantStates.$[sender].unreadCount': 0,
                'participantStates.$[sender].lastReadAt': now,
            },
            $inc: { 'participantStates.$[other].unreadCount': 1 },
        },
        {
            arrayFilters: [{ 'sender.userId': senderObjectId }, { 'other.userId': { $ne: senderObjectId } }],
        }
    );
};

const createSystemMessage = async (conversation: IChatConversation, body: string, actorId?: string) => {
    const senderId = actorId && mongoose.Types.ObjectId.isValid(actorId) ? actorId : toId(conversation.createdBy);
    if (!senderId || !mongoose.Types.ObjectId.isValid(senderId)) {
        return null;
    }

    const now = new Date();
    const message = await ChatMessage.create({
        conversationId: conversation._id,
        senderId: toObjectId(senderId),
        body,
        system: true,
    });

    await applyMessageToConversation(conversation, message, senderId, body.slice(0, 500), now);

    const populatedMessage = await populateMessage(ChatMessage.findById(message._id));
    await emitConversationSnapshot(conversation, populatedMessage);

    return populatedMessage;
};

const createUserMessage = async ({
    conversation,
    userId,
    body,
    attachments = [],
}: {
    conversation: IChatConversation;
    userId: string;
    body: string;
    attachments?: IChatAttachment[];
}) => {
    const now = new Date();
    const message = await ChatMessage.create({
        conversationId: conversation._id,
        senderId: toObjectId(userId),
        body,
        attachments,
    });

    await applyMessageToConversation(conversation, message, userId, getMessagePreview(body, attachments), now);

    const populatedMessage = await populateMessage(ChatMessage.findById(message._id));
    await emitConversationSnapshot(conversation, populatedMessage);

    return populatedMessage;
};

export const ensureMaintenanceConversation = async (maintenanceId: string, actorId?: string, req?: Request) => {
    const context = await resolveMaintenanceContext(maintenanceId, req);
    const existing = await ChatConversation.findOne({
        isDeleted: { $ne: true },
        'context.type': 'maintenance',
        'context.id': maintenanceId,
    });

    if (existing) {
        const expectedParticipantIds = await getMaintenanceParticipantIds(context, actorId);
        const existingIds = new Set(existing.participantIds.map((id) => String(id)));
        let changed = false;

        for (const id of expectedParticipantIds) {
            if (existingIds.has(id)) continue;
            existing.participantIds.push(toObjectId(id));
            existing.participantStates.push({
                userId: toObjectId(id),
                unreadCount: 0,
                muted: false,
            });
            changed = true;
        }

        if (changed) {
            await existing.save();
        }

        return existing;
    }

    const participantIds = await getMaintenanceParticipantIds(context, actorId);
    const now = new Date();

    const conversation = await ChatConversation.create({
        type: 'workflow_thread',
        title: context.title,
        plantId: context.plantId && mongoose.Types.ObjectId.isValid(context.plantId) ? toObjectId(context.plantId) : undefined,
        context: {
            type: 'maintenance',
            id: maintenanceId,
            label: context.label,
            path: context.path,
        },
        participantIds: participantIds.map(toObjectId),
        participantStates: participantIds.map((id) => ({
            userId: toObjectId(id),
            unreadCount: 0,
            lastReadAt: id === actorId ? now : undefined,
            muted: false,
        })),
        createdBy: actorId && mongoose.Types.ObjectId.isValid(actorId) ? toObjectId(actorId) : undefined,
        lastMessageAt: now,
    });

    return conversation;
};

export const appendMaintenanceSystemMessage = async (maintenanceId: string, body: string, actorId?: string) => {
    try {
        const conversation = await ensureMaintenanceConversation(maintenanceId, actorId);
        await createSystemMessage(conversation, body, actorId);
    } catch (error) {
        console.error('[Chat] Failed to append maintenance system message:', error);
    }
};

export const getAvailableUsers = async (req: Request, res: Response, _next: NextFunction) => {
    const search = String(req.query.search ?? '').trim();
    const limit = Math.min(Number(req.query.limit || MAX_CHAT_USERS), MAX_CHAT_USERS);
    const filter = getVisibleUserFilter(req);

    if (search) {
        const regex = new RegExp(escapeRegExp(search), 'i');
        filter.$and = [
            {
                $or: [{ fullname: regex }, { username: regex }, { email: regex }, { phone: regex }],
            },
        ];
    }

    const users = await User.find(filter)
        .populate('plantId', 'name code')
        .select('fullname username email role avatarUrl plantId isActive')
        .sort({ fullname: 1, username: 1 })
        .limit(limit)
        .lean();

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: users.map(serializeChatUser),
            message: 'Lay danh sach nguoi dung co the trao doi thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getUnreadSummary = async (req: Request, res: Response, _next: NextFunction) => {
    const unreadCount = req.userId ? await getTotalUnreadForUser(req.userId) : 0;

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { unreadCount },
            message: 'Lay so tin nhan chua doc thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getContextConversation = async (req: Request, res: Response, _next: NextFunction) => {
    const type = String(req.params.type);
    const contextId = String(req.params.id);

    if (!CONTEXT_TYPES.includes(type as (typeof CONTEXT_TYPES)[number])) {
        throw new BadRequestError('Loai hoi thoai nghiep vu chua duoc ho tro');
    }

    const conversation =
        type === 'maintenance' ? await ensureMaintenanceConversation(contextId, req.userId, req) : undefined;

    if (!conversation) {
        throw new NotFoundError('Khong tim thay hoi thoai nghiep vu');
    }

    const populated = await populateConversation(ChatConversation.findById(conversation._id));

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeConversation(populated, req.userId!),
            message: 'Lay hoi thoai nghiep vu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getConversations = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        throw new UnAuthorizedError('Phien dang nhap khong hop le');
    }

    const conversations = await populateConversation(
        ChatConversation.find({
            isDeleted: { $ne: true },
            participantIds: toObjectId(userId),
        })
            .sort({ lastMessageAt: -1, updatedAt: -1 })
            .limit(Math.min(Number(req.query.limit || 60), 100))
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                conversations: conversations.map((conversation: any) => serializeConversation(conversation, userId)),
                unreadCount: await getTotalUnreadForUser(userId),
            },
            message: 'Lay danh sach hoi thoai thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createConversation = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        throw new UnAuthorizedError('Phien dang nhap khong hop le');
    }

    const requestedParticipantIds = normalizeIds(
        Array.isArray(req.body?.participantIds) ? req.body.participantIds : [],
        userId
    );

    if (!requestedParticipantIds.length) {
        throw new BadRequestError('Can chon it nhat mot nguoi de bat dau trao doi');
    }

    if (requestedParticipantIds.length + 1 > MAX_CONVERSATION_PARTICIPANTS) {
        throw new BadRequestError('Hoi thoai co qua nhieu thanh vien');
    }

    await assertReachableUsers(req, requestedParticipantIds);

    const participantIds = [userId, ...requestedParticipantIds].sort();
    const type = participantIds.length === 2 ? 'direct' : 'group';
    const directKey = type === 'direct' ? participantIds.join(':') : undefined;

    if (directKey) {
        const existing = await populateConversation(
            ChatConversation.findOne({
                directKey,
                isDeleted: { $ne: true },
            })
        );

        if (existing) {
            return res.status(StatusCodes.OK).json(
                customResponse({
                    data: serializeConversation(existing, userId),
                    message: 'Hoi thoai da ton tai',
                    status: StatusCodes.OK,
                    success: true,
                })
            );
        }
    }

    const now = new Date();
    const conversation = await ChatConversation.create({
        type,
        title: type === 'group' ? String(req.body?.title ?? '').trim().slice(0, 160) || undefined : undefined,
        directKey,
        participantIds: participantIds.map(toObjectId),
        participantStates: participantIds.map((id) => ({
            userId: toObjectId(id),
            unreadCount: 0,
            lastReadAt: id === userId ? now : undefined,
            muted: false,
        })),
        createdBy: toObjectId(userId),
        lastMessageAt: now,
    });

    await emitConversationSnapshot(conversation);

    const populated = await populateConversation(ChatConversation.findById(conversation._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeConversation(populated, userId),
            message: 'Tao hoi thoai thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const getMessages = async (req: Request, res: Response, _next: NextFunction) => {
    const conversationId = String(req.params.id);
    await ensureConversationMember(conversationId, req.userId);

    const limit = Math.min(Number(req.query.limit || 50), 100);
    const before = req.query.before ? new Date(String(req.query.before)) : undefined;
    const filter: Record<string, any> = {
        conversationId,
        isDeleted: { $ne: true },
    };

    if (before && !Number.isNaN(before.getTime())) {
        filter.createdAt = { $lt: before };
    }

    const messages = await populateMessage(
        ChatMessage.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: messages.reverse().map(serializeMessage),
            message: 'Lay tin nhan thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const sendMessage = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    const conversationId = String(req.params.id);
    const conversation = await ensureConversationMember(conversationId, userId);
    const body = String(req.body?.body ?? '').trim();

    if (!body) {
        throw new BadRequestError('Noi dung tin nhan khong duoc de trong');
    }

    if (body.length > MAX_MESSAGE_LENGTH) {
        throw new BadRequestError('Tin nhan qua dai');
    }

    const populatedMessage = await createUserMessage({
        conversation,
        userId: userId!,
        body,
    });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeMessage(populatedMessage),
            message: 'Gui tin nhan thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const sendAttachmentMessage = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    const conversationId = String(req.params.id);
    const conversation = await ensureConversationMember(conversationId, userId);
    const body = String(req.body?.body ?? '').trim();
    const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];

    if (body.length > MAX_MESSAGE_LENGTH) {
        throw new BadRequestError('Tin nhan qua dai');
    }

    if (!files.length && !body) {
        throw new BadRequestError('Can nhap noi dung hoac chon anh de gui');
    }

    if (files.length > MAX_CHAT_ATTACHMENTS) {
        throw new BadRequestError(`Chi duoc gui toi da ${MAX_CHAT_ATTACHMENTS} anh moi lan`);
    }

    const attachments = files.length ? await Promise.all(files.map(uploadChatImage)) : [];
    const populatedMessage = await createUserMessage({
        conversation,
        userId: userId!,
        body,
        attachments,
    });

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeMessage(populatedMessage),
            message: 'Gui anh thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const recallMessage = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    const conversationId = String(req.params.id);
    const messageId = String(req.params.messageId);
    const conversation = await ensureConversationMember(conversationId, userId);

    const target = await ChatMessage.findOne({
        _id: messageId,
        conversationId: conversation._id,
        isDeleted: { $ne: true },
    });

    if (!target) {
        throw new NotFoundError('Khong tim thay tin nhan');
    }

    if (target.system) {
        throw new BadRequestError('Khong the thu hoi tin nhan he thong');
    }

    if (String(target.senderId) !== userId) {
        throw new UnAuthorizedError('Chi co the thu hoi tin nhan cua chinh ban');
    }

    target.isDeleted = true;
    target.deletedAt = new Date();
    await target.save();

    // Xoá ảnh trên Cloudinary best-effort, không chặn luồng thu hồi
    for (const attachment of target.attachments ?? []) {
        if (attachment.publicId) {
            void cloudinary.uploader.destroy(attachment.publicId).catch(() => undefined);
        }
    }

    if (String(conversation.lastMessageId) === messageId) {
        await ChatConversation.updateOne(
            { _id: conversation._id },
            { $set: { lastMessagePreview: 'Tin nhắn đã được thu hồi' } }
        );
    }

    const populated = await populateMessage(ChatMessage.findById(target._id));
    const serialized = serializeMessage(populated);

    conversation.participantIds.forEach((participantId) => {
        const id = String(participantId);
        if (!id) return;
        emitToUser(id, 'chat:message:recalled', {
            conversationId: String(conversation._id),
            message: serialized,
        });
    });

    await emitConversationSnapshot(conversation);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serialized,
            message: 'Thu hoi tin nhan thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const setConversationMuted = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    const conversationId = String(req.params.id);
    const conversation = await ensureConversationMember(conversationId, userId);
    const muted = req.body?.muted === true;

    const hasState = (conversation.participantStates ?? []).some((state) => String(state.userId) === userId);

    if (hasState) {
        await ChatConversation.updateOne(
            { _id: conversation._id },
            { $set: { 'participantStates.$[me].muted': muted } },
            { arrayFilters: [{ 'me.userId': toObjectId(userId!) }] }
        );
    } else {
        await ChatConversation.updateOne(
            { _id: conversation._id },
            { $push: { participantStates: { userId: toObjectId(userId!), unreadCount: 0, muted } } }
        );
    }

    const populated = await populateConversation(ChatConversation.findById(conversation._id));
    if (populated) {
        emitToUser(userId!, 'chat:conversation:update', {
            conversation: serializeConversation(populated, userId!),
            totalUnread: await getTotalUnreadForUser(userId!),
        });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: { conversationId: String(conversation._id), muted },
            message: muted ? 'Da tat thong bao hoi thoai' : 'Da bat lai thong bao hoi thoai',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const markConversationAsRead = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId;
    const conversationId = String(req.params.id);
    const conversation = await ensureConversationMember(conversationId, userId);
    const now = new Date();
    let foundState = false;

    conversation.participantStates.forEach((state) => {
        if (String(state.userId) === userId) {
            foundState = true;
            state.unreadCount = 0;
            state.lastReadAt = now;
        }
    });

    if (!foundState && userId) {
        conversation.participantStates.push({
            userId: toObjectId(userId),
            unreadCount: 0,
            lastReadAt: now,
            muted: false,
        });
    }

    await conversation.save();
    const totalUnread = await getTotalUnreadForUser(userId!);
    const populatedConversation = await populateConversation(ChatConversation.findById(conversation._id));

    emitToUser(userId!, 'chat:read', {
        conversationId: String(conversation._id),
        unreadCount: 0,
        totalUnread,
    });

    if (populatedConversation) {
        emitToUser(userId!, 'chat:conversation:update', {
            conversation: serializeConversation(populatedConversation, userId!),
            totalUnread,
        });
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: {
                conversationId: String(conversation._id),
                unreadCount: 0,
                totalUnread,
            },
            message: 'Da danh dau hoi thoai la da doc',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
