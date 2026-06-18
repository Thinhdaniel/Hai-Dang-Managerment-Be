import mongoose from 'mongoose';

// Bộ đếm tăng dần dùng chung, key = tiền tố mã máy (vd "1K-HIKARI-HD"). Tăng nguyên tử bằng $inc.
const CounterSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, trim: true },
        seq: { type: Number, default: 0 },
    },
    { timestamps: true, versionKey: false }
);

const Counter = mongoose.model('Counter', CounterSchema);

export default Counter;
