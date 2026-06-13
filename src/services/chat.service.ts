import { USER_ROLE } from '@/constant/allowedRoles';
import cloudinaryConfig from '@/config/cloudinary.config';
import { BadRequestError, NotFoundError, UnAuthorizedError } from '@/errors/customError';
import { emitToUser } from '@/lib/socket';
import ChatConversation, { type IChatConversation } from '@/models/ChatConversation';
import ChatMessage, { type IChatAttachment, type IChatMessage } from '@/models/ChatMessage';
import DistributionRecord from '@/models/DistributionRecord';
import Maintenance from '@/models/Maintenance';
import PurchaseRequest from '@/models/PurchaseRequest';
import Transfer from '@/models/Transfer';
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
const CONTEXT_TYPES = ['maintenance', 'transfer', 'purchase_request', 'supply_request', 'distribution'] as const;
export type WorkflowContextType = (typeof CONTEXT_TYPES)[number];

// Ngữ cảnh chung cho mọi loại phiếu có thread trao đổi
type WorkflowContext = {
    title: string;
    label: string;
    path: string;
    plantId?: string; // cơ sở chính gắn vào conversation.plantId
    plantIds: string[]; // mọi cơ sở liên quan: quyết định quản lý nào được vào + quyền truy cập
    creatorId?: string;
};

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
    return `MNT-${year}-${String(maintenance?._id ?? maintenance?.id ?? '')
        .slice(-5)
        .toUpperCase()}`;
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

// Route FE tương ứng từng loại phiếu — luôn derive từ type + id để path lưu cũ trong DB không gây link hỏng
const buildWorkflowPath = (type: WorkflowContextType, id: string): string => {
    switch (type) {
        case 'maintenance':
            return `/maintenances?maintenance=${id}`;
        case 'transfer':
            return `/transfers/${id}`;
        case 'purchase_request':
            return `/materials/purchase-requests?request=${id}`;
        case 'supply_request':
            return `/materials/supply-requests?request=${id}`;
        case 'distribution':
            return `/materials/distributions?record=${id}`;
    }
};

const serializeContext = (context: any) => {
    if (!context?.type) return undefined;

    const id = context.id ? String(context.id) : undefined;
    const isKnownType = CONTEXT_TYPES.includes(context.type);

    return {
        type: context.type,
        id,
        label: context.label,
        path: id && isKnownType ? buildWorkflowPath(context.type as WorkflowContextType, id) : context.path,
    };
};

const serializeConversation = (conversation: IChatConversation | any, currentUserId: string) => {
    const state = getParticipantState(conversation, currentUserId);
    const plant =
        conversation?.plantId && typeof conversation.plantId === 'object'
            ? getPlantSummary(conversation.plantId)
            : undefined;

    return {
        id: toId(conversation),
        type: conversation.type,
        title: getConversationTitle(conversation, currentUserId),
        plantId: plant?.id ?? toId(conversation?.plantId),
        plant,
        context: serializeContext(conversation.context),
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

// Trích gọn tin được trả lời (quote) để hiển thị, không lồng sâu
const serializeReplyPreview = (reply: any) => {
    if (!reply || typeof reply !== 'object') return undefined;
    const senderName =
        reply.senderId && typeof reply.senderId === 'object' ? getUserDisplayName(reply.senderId) : undefined;
    const hasImage = Array.isArray(reply.attachments) && reply.attachments.some((a: any) => a?.type === 'image');
    return {
        id: toId(reply),
        senderId: toId(reply.senderId),
        senderName,
        body: reply.isDeleted ? 'Tin nhắn đã được thu hồi' : (reply.body ?? ''),
        hasImage: reply.isDeleted ? false : hasImage,
        isDeleted: reply.isDeleted === true,
    };
};

const serializeMessage = (message: IChatMessage | any) => ({
    id: toId(message),
    conversationId: toId(message.conversationId),
    senderId: toId(message.senderId),
    sender: message.senderId && typeof message.senderId === 'object' ? serializeChatUser(message.senderId) : undefined,
    body: message.isDeleted ? 'Tin nhắn đã được thu hồi' : message.body,
    attachments: message.isDeleted ? [] : (message.attachments ?? []),
    replyTo: message.isDeleted ? undefined : serializeReplyPreview(message.replyTo),
    reactions: (message.reactions ?? []).map((r: any) => ({ userId: toId(r.userId), emoji: r.emoji })),
    pinned: message.pinned === true,
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
    query
        .populate({
            path: 'senderId',
            select: 'fullname username email role avatarUrl plantId isActive',
            populate: { path: 'plantId', select: 'name code' },
        })
        .populate({
            path: 'replyTo',
            select: 'body senderId attachments isDeleted system',
            populate: { path: 'senderId', select: 'fullname username' },
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

const buildWorkflowCode = (prefix: string, doc: any) => {
    const baseDate = doc?.createdAt || new Date();
    const year = new Date(baseDate).getFullYear();
    return `${prefix}-${year}-${String(doc?._id ?? '')
        .slice(-5)
        .toUpperCase()}`;
};

const resolveMaintenanceContext = async (maintenanceId: string): Promise<WorkflowContext> => {
    const maintenance = await Maintenance.findOne({ _id: maintenanceId, isDeleted: { $ne: true } })
        .populate({
            path: 'assetId',
            populate: [{ path: 'brandId' }, { path: 'plantId', select: 'name code' }],
        })
        .populate('plantId', 'name code')
        .lean();

    if (!maintenance) {
        throw new NotFoundError('Khong tim thay phieu bao tri');
    }

    const asset = (maintenance as any).assetId;
    const plantId = toId((maintenance as any).plantId) ?? toId(asset?.plantId);
    const code = buildMaintenanceCode(maintenance);
    const assetName = asset?.name || 'Máy chưa xác định';
    const machineCode = asset?.machineCode;

    return {
        title: `Bảo trì ${machineCode || assetName}`,
        label: `${code} · ${assetName}`,
        path: buildWorkflowPath('maintenance', maintenanceId),
        plantId,
        plantIds: plantId ? [plantId] : [],
        creatorId: toId((maintenance as any).createdBy),
    };
};

const resolveTransferContext = async (transferId: string): Promise<WorkflowContext> => {
    const transfer = await Transfer.findOne({ _id: transferId, isDeleted: { $ne: true } })
        .populate('assetId', 'name machineCode')
        .populate('assetIds', 'name machineCode')
        .populate('fromPlantId', 'name code')
        .populate('toPlantId', 'name code')
        .lean();

    if (!transfer) {
        throw new NotFoundError('Khong tim thay lenh dieu chuyen');
    }

    const record = transfer as any;
    const assets =
        Array.isArray(record.assetIds) && record.assetIds.length ? record.assetIds : [record.assetId].filter(Boolean);
    const firstAsset = assets[0];
    const assetLabel =
        assets.length > 1 ? `${assets.length} máy` : firstAsset?.machineCode || firstAsset?.name || 'máy';
    const code = buildWorkflowCode('DC', record);
    const fromName = record.fromPlantId?.name || 'Cơ sở đi';
    const toName = record.toPlantId?.name || 'Cơ sở nhận';
    const plantIds = Array.from(
        new Set([toId(record.fromPlantId), toId(record.toPlantId)].filter(Boolean) as string[])
    );

    return {
        title: `Điều chuyển ${assetLabel}`,
        label: `${code} · ${fromName} → ${toName}`,
        path: buildWorkflowPath('transfer', transferId),
        plantId: plantIds[0],
        plantIds,
        creatorId: toId(record.createdBy),
    };
};

const resolvePurchaseRequestContext = async (
    type: 'purchase_request' | 'supply_request',
    requestId: string
): Promise<WorkflowContext> => {
    const request = await PurchaseRequest.findOne({ _id: requestId, isDeleted: { $ne: true } })
        .populate('plantId', 'name code')
        .populate('fromPlantId', 'name code')
        .populate('toPlantId', 'name code')
        .lean();

    if (!request) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    const record = request as any;
    const isSupply = type === 'supply_request';
    const expectedRequestType = isSupply ? 'supply_request' : 'purchase';
    if ((record.requestType ?? 'purchase') !== expectedRequestType) {
        throw new NotFoundError('Khong tim thay phieu de xuat');
    }

    const code = record.requestCode || buildWorkflowCode(isSupply ? 'YCVT' : 'DXM', record);
    const plantName = record.plantId?.name || record.fromPlantId?.name || 'Cơ sở';
    const plantIds = Array.from(
        new Set([toId(record.plantId), toId(record.fromPlantId), toId(record.toPlantId)].filter(Boolean) as string[])
    );

    return {
        title: isSupply ? `Yêu cầu vật tư ${code}` : `Đề xuất mua ${code}`,
        label: `${code} · ${plantName}`,
        path: buildWorkflowPath(type, requestId),
        plantId: toId(record.plantId) ?? plantIds[0],
        plantIds,
        creatorId: toId(record.requestedBy),
    };
};

const resolveDistributionContext = async (recordId: string): Promise<WorkflowContext> => {
    const distribution = await DistributionRecord.findOne({ _id: recordId, isDeleted: { $ne: true } })
        .populate('fromPlantId', 'name code')
        .populate('toPlantId', 'name code')
        .lean();

    if (!distribution) {
        throw new NotFoundError('Khong tim thay phieu cap phat');
    }

    const record = distribution as any;
    const code = record.distributionCode || buildWorkflowCode('CP', record);
    const routeLabel =
        [record.fromPlantId?.name, record.toPlantId?.name].filter(Boolean).join(' → ') || 'Cấp phát nội bộ';
    const plantIds = Array.from(
        new Set([toId(record.fromPlantId), toId(record.toPlantId)].filter(Boolean) as string[])
    );

    return {
        title: `Cấp phát ${code}`,
        label: `${code} · ${routeLabel}`,
        path: buildWorkflowPath('distribution', recordId),
        plantId: toId(record.toPlantId) ?? plantIds[0],
        plantIds,
        creatorId: toId(record.distributedBy),
    };
};

const assertWorkflowAccess = (req: Request | undefined, context: WorkflowContext) => {
    if (!req || isManagerRole(req.role)) return;

    const currentUserPlantId = getUserPlantId(req);
    const isCreator = Boolean(req.userId && context.creatorId && context.creatorId === req.userId);
    const samePlant = Boolean(currentUserPlantId && context.plantIds.includes(currentUserPlantId));

    if (!isCreator && !samePlant) {
        throw new UnAuthorizedError('Ban khong co quyen trao doi tren phieu nay');
    }
};

const resolveWorkflowContext = async (
    type: WorkflowContextType,
    id: string,
    req?: Request
): Promise<WorkflowContext> => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new NotFoundError('Khong tim thay phieu');
    }

    const context =
        type === 'maintenance'
            ? await resolveMaintenanceContext(id)
            : type === 'transfer'
              ? await resolveTransferContext(id)
              : type === 'distribution'
                ? await resolveDistributionContext(id)
                : await resolvePurchaseRequestContext(type, id);

    assertWorkflowAccess(req, context);

    return context;
};

const getWorkflowParticipantIds = async (context: WorkflowContext, actorId?: string) => {
    const participantIds = normalizeIds([actorId, context.creatorId], undefined);

    const managementFilter: Record<string, any> = {
        isDeleted: { $ne: true },
        isActive: true,
        role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER] },
    };

    const managementUsers = await User.find(managementFilter).select('_id role plantId').lean();

    for (const manager of managementUsers) {
        const managerId = toId(manager);
        if (!managerId) continue;

        const managerRole = String((manager as any).role);
        const managerPlantId = toId((manager as any).plantId);
        const shouldInclude =
            managerRole === USER_ROLE.ADMIN ||
            managerRole === USER_ROLE.DIRECTOR ||
            !context.plantIds.length ||
            (managerPlantId ? context.plantIds.includes(managerPlantId) : false);

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

// Chỉ cho reply tới tin hợp lệ trong cùng hội thoại, chưa bị thu hồi
const resolveReplyTo = async (conversationId: mongoose.Types.ObjectId, replyToId?: string) => {
    if (!replyToId || !mongoose.Types.ObjectId.isValid(replyToId)) return undefined;
    const target = await ChatMessage.findOne({
        _id: replyToId,
        conversationId,
        isDeleted: { $ne: true },
    }).select('_id');
    return target ? target._id : undefined;
};

const createUserMessage = async ({
    conversation,
    userId,
    body,
    attachments = [],
    replyTo,
}: {
    conversation: IChatConversation;
    userId: string;
    body: string;
    attachments?: IChatAttachment[];
    replyTo?: mongoose.Types.ObjectId;
}) => {
    const now = new Date();
    const message = await ChatMessage.create({
        conversationId: conversation._id,
        senderId: toObjectId(userId),
        body,
        attachments,
        replyTo,
    });

    await applyMessageToConversation(conversation, message, userId, getMessagePreview(body, attachments), now);

    const populatedMessage = await populateMessage(ChatMessage.findById(message._id));
    await emitConversationSnapshot(conversation, populatedMessage);

    return populatedMessage;
};

export const ensureWorkflowConversation = async (
    type: WorkflowContextType,
    contextId: string,
    actorId?: string,
    req?: Request
) => {
    const context = await resolveWorkflowContext(type, contextId, req);
    const existing = await ChatConversation.findOne({
        isDeleted: { $ne: true },
        'context.type': type,
        'context.id': contextId,
    });

    if (existing) {
        const expectedParticipantIds = await getWorkflowParticipantIds(context, actorId);
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

        // Context lưu cứng lúc tạo có thể lỗi thời (đổi route FE, đổi tên máy/cơ sở) — đồng bộ lại
        if (existing.context && (existing.context.path !== context.path || existing.context.label !== context.label)) {
            existing.context.path = context.path;
            existing.context.label = context.label;
            existing.markModified('context');
            changed = true;
        }

        if (changed) {
            await existing.save();
        }

        return existing;
    }

    const participantIds = await getWorkflowParticipantIds(context, actorId);
    const now = new Date();

    const conversation = await ChatConversation.create({
        type: 'workflow_thread',
        title: context.title,
        plantId:
            context.plantId && mongoose.Types.ObjectId.isValid(context.plantId)
                ? toObjectId(context.plantId)
                : undefined,
        context: {
            type,
            id: contextId,
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

export const appendWorkflowSystemMessage = async (
    type: WorkflowContextType,
    contextId: string,
    body: string,
    actorId?: string
) => {
    try {
        const conversation = await ensureWorkflowConversation(type, contextId, actorId);
        await createSystemMessage(conversation, body, actorId);
    } catch (error) {
        console.error(`[Chat] Failed to append ${type} system message:`, error);
    }
};

export const appendMaintenanceSystemMessage = async (maintenanceId: string, body: string, actorId?: string) =>
    appendWorkflowSystemMessage('maintenance', maintenanceId, body, actorId);

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

    if (!CONTEXT_TYPES.includes(type as WorkflowContextType)) {
        throw new BadRequestError('Loai hoi thoai nghiep vu chua duoc ho tro');
    }

    const conversation = await ensureWorkflowConversation(type as WorkflowContextType, contextId, req.userId, req);

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
        title:
            type === 'group'
                ? String(req.body?.title ?? '')
                      .trim()
                      .slice(0, 160) || undefined
                : undefined,
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

    const messages = await populateMessage(ChatMessage.find(filter).sort({ createdAt: -1 }).limit(limit));

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

    const replyTo = await resolveReplyTo(conversation._id, req.body?.replyTo);
    const populatedMessage = await createUserMessage({
        conversation,
        userId: userId!,
        body,
        replyTo,
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

    const replyTo = await resolveReplyTo(conversation._id, req.body?.replyTo);
    const attachments = files.length ? await Promise.all(files.map(uploadChatImage)) : [];
    const populatedMessage = await createUserMessage({
        conversation,
        userId: userId!,
        body,
        attachments,
        replyTo,
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

const ALLOWED_REACTIONS = ['👍', '❤️', '😆', '😮', '😢', '🙏'];

// Phát tin nhắn đã đổi (reaction/ghim) tới mọi thành viên để FE cập nhật tại chỗ
const emitMessageUpdated = (conversation: IChatConversation, serialized: any) => {
    conversation.participantIds.forEach((participantId) => {
        const id = String(participantId);
        if (!id) return;
        emitToUser(id, 'chat:message:updated', {
            conversationId: String(conversation._id),
            message: serialized,
        });
    });
};

const findActiveMessage = async (conversation: IChatConversation, messageId: string) => {
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
        throw new NotFoundError('Khong tim thay tin nhan');
    }
    const target = await ChatMessage.findOne({
        _id: messageId,
        conversationId: conversation._id,
        isDeleted: { $ne: true },
    });
    if (!target) {
        throw new NotFoundError('Khong tim thay tin nhan');
    }
    return target;
};

export const toggleReaction = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const conversation = await ensureConversationMember(String(req.params.id), userId);
    const target = await findActiveMessage(conversation, String(req.params.messageId));
    const emoji = String(req.body?.emoji ?? '').trim();

    if (!ALLOWED_REACTIONS.includes(emoji)) {
        throw new BadRequestError('Cam xuc khong hop le');
    }
    if (target.system) {
        throw new BadRequestError('Khong the tha cam xuc len tin nhan he thong');
    }

    const mine = (target.reactions ?? []).find((r) => String(r.userId) === userId);
    // Mỗi người 1 cảm xúc: bấm lại đúng emoji = gỡ, bấm emoji khác = thay
    target.reactions = (target.reactions ?? []).filter((r) => String(r.userId) !== userId) as any;
    if (!mine || mine.emoji !== emoji) {
        target.reactions.push({ userId: toObjectId(userId), emoji, at: new Date() } as any);
    }
    await target.save();

    const serialized = serializeMessage(await populateMessage(ChatMessage.findById(target._id)));
    emitMessageUpdated(conversation, serialized);

    return res
        .status(StatusCodes.OK)
        .json(
            customResponse({
                data: serialized,
                message: 'Cap nhat cam xuc thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
};

export const togglePin = async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const conversation = await ensureConversationMember(String(req.params.id), userId);
    const target = await findActiveMessage(conversation, String(req.params.messageId));

    if (target.system) {
        throw new BadRequestError('Khong the ghim tin nhan he thong');
    }

    const nextPinned = !target.pinned;
    target.pinned = nextPinned;
    target.pinnedAt = nextPinned ? new Date() : undefined;
    target.pinnedBy = nextPinned ? toObjectId(userId) : undefined;
    await target.save();

    const serialized = serializeMessage(await populateMessage(ChatMessage.findById(target._id)));
    emitMessageUpdated(conversation, serialized);

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serialized,
            message: nextPinned ? 'Da ghim tin nhan' : 'Da bo ghim tin nhan',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const getPinnedMessages = async (req: Request, res: Response, _next: NextFunction) => {
    const conversation = await ensureConversationMember(String(req.params.id), req.userId);
    const pinned = await populateMessage(
        ChatMessage.find({ conversationId: conversation._id, pinned: true, isDeleted: { $ne: true } })
            .sort({ pinnedAt: -1 })
            .limit(20)
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: pinned.map(serializeMessage),
            message: 'Lay tin ghim thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const searchMessages = async (req: Request, res: Response, _next: NextFunction) => {
    const conversation = await ensureConversationMember(String(req.params.id), req.userId);
    const keyword = String(req.query.q ?? '').trim();

    if (keyword.length < 2) {
        return res
            .status(StatusCodes.OK)
            .json(customResponse({ data: [], message: 'Tu khoa qua ngan', status: StatusCodes.OK, success: true }));
    }

    const regex = new RegExp(escapeRegExp(keyword), 'i');
    const matched = await populateMessage(
        ChatMessage.find({
            conversationId: conversation._id,
            isDeleted: { $ne: true },
            system: { $ne: true },
            body: regex,
        })
            .sort({ createdAt: -1 })
            .limit(40)
    );

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: matched.map(serializeMessage),
            message: 'Tim tin nhan thanh cong',
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
