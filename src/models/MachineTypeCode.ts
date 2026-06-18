import mongoose from 'mongoose';

// Ghi nhớ mã viết tắt cho từng loại máy: lần đầu gặp -> đề xuất + lưu; lần sau tái dùng.
const MachineTypeCodeSchema = new mongoose.Schema(
    {
        typeKey: { type: String, required: true, unique: true, trim: true }, // khoá chuẩn hoá của loại máy
        code: { type: String, required: true, trim: true, uppercase: true }, // mã viết tắt (1K, VS...)
        label: { type: String, trim: true }, // tên loại máy gốc để hiển thị
    },
    { timestamps: true, versionKey: false }
);

const MachineTypeCode = mongoose.model('MachineTypeCode', MachineTypeCodeSchema);

export default MachineTypeCode;
