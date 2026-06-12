import mongoose from 'mongoose';

export type ChatAttachmentType = 'image' | 'file';

export interface IChatAttachment {
    type: ChatAttachmentType;
    url: string;
    publicId?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
}

export interface IChatMessage extends mongoose.Document {
    conversationId: mongoose.Types.ObjectId;
    senderId: mongoose.Types.ObjectId;
    body: string;
    attachments: IChatAttachment[];
    system: boolean;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const ChatAttachmentSchema = new mongoose.Schema<IChatAttachment>(
    {
        type: {
            type: String,
            enum: ['image', 'file'],
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

const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
