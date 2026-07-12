import mongoose from 'mongoose';

// Bộ nhớ map tên hàng NCC -> vật tư nội bộ, học từ mỗi lần kế toán đối soát tay.
// Lần giao sau cùng NCC + cùng tên/mã hàng -> tự map ngay, không cần AI.
const SupplierItemAliasSchema = new mongoose.Schema(
    {
        // Tên NCC đã chuẩn hoá (bỏ dấu, thường hoá) — phiếu các lần in tên hơi khác nhau vẫn trúng
        supplierKey: { type: String, required: true, trim: true, index: true },
        supplierName: { type: String, trim: true },
        // Tên hàng trên phiếu NCC đã chuẩn hoá
        aliasKey: { type: String, required: true, trim: true },
        aliasText: { type: String, trim: true },
        // Mã hàng NCC (trích từ cột Mã hàng/ghi chú) — tín hiệu khớp mạnh nhất
        aliasCode: { type: String, trim: true, uppercase: true },
        // Vật tư nội bộ tương ứng (tên dòng đơn người dùng đã chọn)
        targetMaterialName: { type: String, required: true, trim: true },
        targetMaterialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
        targetUnit: { type: String, trim: true },
        useCount: { type: Number, default: 1, min: 1 },
        lastUsedAt: { type: Date, default: Date.now },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true, versionKey: false }
);

SupplierItemAliasSchema.index({ supplierKey: 1, aliasKey: 1 }, { unique: true });
SupplierItemAliasSchema.index({ supplierKey: 1, aliasCode: 1 });

export default mongoose.model('SupplierItemAlias', SupplierItemAliasSchema);
