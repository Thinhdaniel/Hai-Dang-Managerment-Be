import mongoose from 'mongoose';

const EntrySchema = new mongoose.Schema(
    {
        itemCode: { type: String, required: true, trim: true, maxlength: 100 },
        operation: { type: String, required: true, trim: true, maxlength: 120 },
        quantity: { type: Number, required: true, min: 0.01, max: 10000000 },
        unit: { type: String, required: true, trim: true, maxlength: 30, default: 'SP' },
        note: { type: String, trim: true, maxlength: 300, default: '' },
    },
    { timestamps: true }
);

const WorkerNotebookSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        date: { type: String, required: true },
        attended: { type: Boolean, default: false },
        attendanceType: { type: String, enum: ['full', 'half', 'off'] },
        overtimeHours: { type: Number, min: 0, max: 24, default: 0 },
        attendedAt: { type: Date },
        entries: { type: [EntrySchema], default: [] },
    },
    { timestamps: true }
);

WorkerNotebookSchema.index({ userId: 1, date: 1 }, { unique: true });

export default mongoose.model('WorkerNotebook', WorkerNotebookSchema);
