import mongoose from 'mongoose';

const MaintenanceSchema = new mongoose.Schema(
    {
        // Máy chính (giữ tương thích logic per-máy: trạng thái, snapshot cơ sở...)
        assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Asset',
            required: true,
        },
        // Toàn bộ máy trong phiếu (gồm cả máy chính) — cho phép 1 phiếu nhiều máy
        assetIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Asset' }],
            default: [],
        },
        type: {
            type: String,
            enum: ['periodic', 'emergency', 'inspection'],
            required: true,
        },
        repairMode: {
            type: String,
            enum: ['internal', 'external'],
            default: 'internal',
        },
        status: {
            type: String,
            enum: ['pending', 'in_progress', 'completed', 'overdue', 'cancelled'],
            default: 'in_progress',
        },
        approvalStatus: {
            type: String,
            enum: ['none', 'pending', 'approved', 'rejected'],
            default: 'none',
        },
        description: {
            type: String,
            required: true,
            trim: true,
        },
        // Ảnh bằng chứng giữ nguyên URL gốc, không được thay thế hoặc ghi đè bằng ảnh AI.
        beforeImages: {
            type: [String],
            default: [],
            validate: [(value: string[]) => value.length <= 6, 'Toi da 6 anh truoc sua'],
        },
        afterImages: {
            type: [String],
            default: [],
            validate: [(value: string[]) => value.length <= 6, 'Toi da 6 anh sau sua'],
        },
        startDate: {
            type: Date,
            required: true,
        },
        endDate: {
            type: Date,
        },
        technician: {
            type: String,
            trim: true,
        },
        cost: {
            type: Number,
            min: 0,
        },
        externalRepair: {
            vendorName: {
                type: String,
                trim: true,
            },
            sentOutAt: {
                type: Date,
            },
            expectedReturnAt: {
                type: Date,
            },
            returnedAt: {
                type: Date,
            },
            estimateCost: {
                type: Number,
                min: 0,
            },
            actualCost: {
                type: Number,
                min: 0,
            },
            invoiceNo: {
                type: String,
                trim: true,
            },
            invoiceImageUrl: {
                type: String,
                trim: true,
            },
            costItems: [
                {
                    name: {
                        type: String,
                        trim: true,
                    },
                    amount: {
                        type: Number,
                        min: 0,
                    },
                    note: {
                        type: String,
                        trim: true,
                    },
                },
            ],
            approvedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
            },
            approvedAt: {
                type: Date,
            },
            rejectedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
            },
            rejectedAt: {
                type: Date,
            },
            rejectReason: {
                type: String,
                trim: true,
            },
        },
        note: {
            type: String,
            trim: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        // Snapshot cơ sở tại thời điểm tạo bảo trì — không được thay đổi khi máy điều chuyển
        plantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Plant',
        },
        plantName: {
            type: String,
            trim: true,
        },
        areaAtCreation: {
            type: String,
            trim: true,
        },
        plantSnapshotSource: {
            type: String,
            enum: [
                'created_from_asset',
                'backfilled_from_transfer_history',
                'backfilled_from_current_asset',
                'unknown',
            ],
        },
        plantIdBackfilled: {
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

MaintenanceSchema.index({ assetId: 1 });
MaintenanceSchema.index({ status: 1 });
MaintenanceSchema.index({ type: 1 });
MaintenanceSchema.index({ repairMode: 1 });
MaintenanceSchema.index({ approvalStatus: 1 });
MaintenanceSchema.index({ plantId: 1 });

const Maintenance = mongoose.model('Maintenance', MaintenanceSchema);

export default Maintenance;
