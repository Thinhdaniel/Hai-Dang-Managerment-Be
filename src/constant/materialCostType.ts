/**
 * Phân loại bản chất chi phí của vật tư/máy trong danh mục (gán 1 lần ở danh mục,
 * mọi phiếu mua/cấp phát kế thừa). Dùng để tách OPEX vs CAPEX trên báo cáo:
 *  - consumable + spare_part => chi phí vận hành (OPEX) tính vào chart chi phí.
 *  - tool + asset           => mua sắm/đầu tư (CAPEX) tách riêng, không độn chi phí.
 * Trường rỗng = CHƯA phân loại (cần rà).
 */
export enum MATERIAL_COST_TYPE {
    CONSUMABLE = 'consumable', // Vật tư tiêu hao (chỉ, kim, dầu, nhãn...) - dùng hết
    SPARE_PART = 'spare_part', // Linh kiện thay thế (thoi, ổ, dây curoa, bo mạch...)
    TOOL = 'tool', // CCDC tái sử dụng (kéo, gá, khuôn, dưỡng, kẹp...)
    ASSET = 'asset', // Máy móc / tài sản (máy may, máy cắt...)
}

export const MATERIAL_COST_TYPE_VALUES = Object.values(MATERIAL_COST_TYPE);

export const MATERIAL_COST_TYPE_LABEL: Record<MATERIAL_COST_TYPE, string> = {
    [MATERIAL_COST_TYPE.CONSUMABLE]: 'Vật tư tiêu hao',
    [MATERIAL_COST_TYPE.SPARE_PART]: 'Linh kiện thay thế',
    [MATERIAL_COST_TYPE.TOOL]: 'CCDC (tái sử dụng)',
    [MATERIAL_COST_TYPE.ASSET]: 'Máy móc / tài sản',
};

// Nhóm dùng cho báo cáo: OPEX tính vào chi phí vận hành; CAPEX tách riêng.
export const OPEX_COST_TYPES: MATERIAL_COST_TYPE[] = [MATERIAL_COST_TYPE.CONSUMABLE, MATERIAL_COST_TYPE.SPARE_PART];
export const CAPEX_COST_TYPES: MATERIAL_COST_TYPE[] = [MATERIAL_COST_TYPE.TOOL, MATERIAL_COST_TYPE.ASSET];
