import mongoose from 'mongoose';

const MaterialRecipientSchema = new mongoose.Schema(
    {
        employeeCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
        fullName: { type: String, required: true, trim: true, maxlength: 160 },
        plantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plant', required: true },
        department: { type: String, trim: true, maxlength: 120 },
        lineName: { type: String, trim: true, maxlength: 120 },
        phone: { type: String, trim: true, maxlength: 30 },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
    },
    { timestamps: true, versionKey: false }
);

MaterialRecipientSchema.index(
    { plantId: 1, employeeCode: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false } }
);
MaterialRecipientSchema.index({ plantId: 1, isActive: 1, fullName: 1 });

export default mongoose.model('MaterialRecipient', MaterialRecipientSchema);
