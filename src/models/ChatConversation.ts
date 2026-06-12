import mongoose from 'mongoose';

export type ChatConversationType = 'direct' | 'group' | 'plant_group' | 'role_group' | 'workflow_thread';
export type ChatWorkflowContextType =
    | 'asset'
    | 'maintenance'
    | 'transfer'
    | 'borrowing'
    | 'purchase_request'
    | 'supply_request'
    | 'purchase_order'
    | 'distribution'
    | 'system';

export interface IChatParticipantState {
    userId: mongoose.Types.ObjectId;
    lastReadAt?: Date;
    unreadCount: number;
    muted: boolean;
    archivedAt?: Date | null;
}

export interface IChatConversation extends mongoose.Document {
    type: ChatConversationType;
    title?: string;
    directKey?: string;
    plantId?: mongoose.Types.ObjectId;
    roleKey?: string;
    context?: {
        type: ChatWorkflowContextType;
        id?: string;
        label?: string;
        path?: string;
    };
    participantIds: mongoose.Types.ObjectId[];
    participantStates: IChatParticipantState[];
    createdBy?: mongoose.Types.ObjectId;
    lastMessageId?: mongoose.Types.ObjectId;
    lastMessageSenderId?: mongoose.Types.ObjectId;
    lastMessagePreview?: string;
    lastMessageAt?: Date;
    isDeleted: boolean;
    deletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const ChatParticipantStateSchema = new mongoose.Schema<IChatParticipantState>(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        lastReadAt: {
            type: Date,
        },
        unreadCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        muted: {
            type: Boolean,
            default: false,
        },
        archivedAt: {
            type: Date,
            default: null,
        },
    },
    { _id: false }
);

const ChatConversationSchema = new mongoose.Schema<IChatConversation>(
    {
        type: {
            type: String,
            enum: ['direct', 'group', 'plant_group', 'role_group', 'workflow_thread'],
            default: 'direct',
            index: true,
        },
        title: {
            type: String,
            trim: true,
            maxlength: 160,
        },
        directKey: {
            type: String,
            trim: true,
        },
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        roleKey: {
            type: String,
            trim: true,
        },
        context: {
            type: {
                type: String,
                enum: [
                    'asset',
                    'maintenance',
                    'transfer',
                    'borrowing',
                    'purchase_request',
                    'supply_request',
                    'purchase_order',
                    'distribution',
                    'system',
                ],
            },
            id: {
                type: String,
                trim: true,
            },
            label: {
                type: String,
                trim: true,
                maxlength: 180,
            },
            path: {
                type: String,
                trim: true,
                maxlength: 240,
            },
        },
        participantIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
            default: [],
            index: true,
        },
        participantStates: {
            type: [ChatParticipantStateSchema],
            default: [],
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        lastMessageId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ChatMessage',
        },
        lastMessageSenderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        lastMessagePreview: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        lastMessageAt: {
            type: Date,
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

ChatConversationSchema.index({ directKey: 1 }, { unique: true, sparse: true });
ChatConversationSchema.index({ participantIds: 1, lastMessageAt: -1 });
ChatConversationSchema.index({ type: 1, plantId: 1, lastMessageAt: -1 });
ChatConversationSchema.index({ 'context.type': 1, 'context.id': 1 });
ChatConversationSchema.index({ isDeleted: 1, lastMessageAt: -1 });

const ChatConversation = mongoose.model<IChatConversation>('ChatConversation', ChatConversationSchema);

export default ChatConversation;
