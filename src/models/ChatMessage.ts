import mongoose from 'mongoose';

export type ChatAttachmentType = 'image' | 'audio' | 'file';

export interface IChatAttachment {
    type: ChatAttachmentType;
    url: string;
    publicId?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
    durationMs?: number;
}

export interface IChatReaction {
    userId: mongoose.Types.ObjectId;
    emoji: string;
    at: Date;
}

export interface IChatMessage extends mongoose.Document {
    conversationId: mongoose.Types.ObjectId;
    senderId: mongoose.Types.ObjectId;
    body: string;
    attachments: IChatAttachment[];
    replyTo?: mongoose.Types.ObjectId;
    reactions: IChatReaction[];
    mentions: mongoose.Types.ObjectId[];
    pinned: boolean;
    pinnedAt?: Date;
    pinnedBy?: mongoose.Types.ObjectId;
    system: boolean;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const ChatReactionSchema = new mongoose.Schema<IChatReaction>(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        emoji: { type: String, required: true, trim: true, maxlength: 16 },
        at: { type: Date, default: Date.now },
    },
    { _id: false }
);

const ChatAttachmentSchema = new mongoose.Schema<IChatAttachment>(
    {
        type: {
            type: String,
            enum: ['image', 'audio', 'file'],
            required: true,
        },
        url: {
            type: String,
            required: true,
            trim: true,
        },
        publicId: {
            type: String,
            trim: true,
        },
        name: {
            type: String,
            trim: true,
            maxlength: 180,
        },
        mimeType: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        size: {
            type: Number,
            min: 0,
        },
        width: {
            type: Number,
            min: 0,
        },
        height: {
            type: Number,
            min: 0,
        },
        durationMs: {
            type: Number,
            min: 0,
        },
    },
    { _id: false }
);

const ChatMessageSchema = new mongoose.Schema<IChatMessage>(
    {
        conversationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ChatConversation',
            required: true,
            index: true,
        },
        senderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        body: {
            type: String,
            default: '',
            trim: true,
            maxlength: 4000,
        },
        attachments: {
            type: [ChatAttachmentSchema],
            default: [],
        },
        replyTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ChatMessage',
        },
        reactions: {
            type: [ChatReactionSchema],
            default: [],
        },
        // Tài khoản được nhắc (@mention) trong tin — báo riêng kể cả khi tắt thông báo hội thoại
        mentions: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
            default: [],
        },
        pinned: {
            type: Boolean,
            default: false,
        },
        pinnedAt: {
            type: Date,
        },
        pinnedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        system: {
            type: Boolean,
            default: false,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
        deletedAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

ChatMessageSchema.index({ conversationId: 1, createdAt: -1 });
ChatMessageSchema.index({ senderId: 1, createdAt: -1 });
ChatMessageSchema.index({ isDeleted: 1, createdAt: -1 });
ChatMessageSchema.index({ conversationId: 1, pinned: 1 });
ChatMessageSchema.index({ mentions: 1, createdAt: -1 });

const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
