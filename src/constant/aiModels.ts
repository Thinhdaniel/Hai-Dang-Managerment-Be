/**
 * Danh mục các tác vụ AI trong dự án. Mỗi tác vụ có 1 key cố định.
 *
 * Gán model riêng cho từng tác vụ ở 9router qua biến môi trường AI_FEATURE_MODELS (JSON):
 *   AI_FEATURE_MODELS={"asset-search":"oc/nemotron-3-ultra-free","material-match":"oc/deepseek-v4-flash-free"}
 *
 * Thứ tự ưu tiên chọn model (trong ai-provider.service):
 *   1. model truyền trực tiếp trong lời gọi (options.model)
 *   2. model theo tác vụ trong AI_FEATURE_MODELS[feature]
 *   3. AI_MODEL_JSON (khi cần JSON) hoặc AI_MODEL_DEFAULT
 *
 * Khi thêm tính năng AI mới: thêm 1 key vào đây và truyền `feature` vào aiProviderService.
 */
export const AI_FEATURES = {
    ASSET_SEARCH: 'asset-search', // Trợ lý máy: lập query-plan (mức tiêu chuẩn)
    ASSET_ANSWER: 'asset-answer', // Trợ lý máy: diễn giải kết quả (luôn dùng model rẻ)
    MATERIAL_MATCH: 'material-match', // Khớp tên vật tư Excel với danh mục (JSON, cần chính xác)
    CHAT_SUMMARY: 'chat-summary', // Tóm tắt hội thoại nội bộ
    HELP: 'help', // Trợ lý hướng dẫn sử dụng
    DIGEST: 'digest', // Bản tin AI định kỳ cho giám đốc (chất lượng cao, chạy ít lần)
    VARIANCE: 'variance', // Giải thích biến động chỉ số (câu ngắn, theo nhu cầu)
} as const;

/**
 * Auto-switch model theo độ phức tạp câu hỏi (router ở ai-asset-assistant.service):
 *   - asset-search-light : câu đơn giản (liệt kê/đếm/tìm) -> model rẻ/nhanh
 *   - asset-search        : tiêu chuẩn (mặc định)
 *   - asset-search-heavy  : câu phân tích/so sánh/tư vấn -> model mạnh
 * Biến thể chưa map riêng trong AI_FEATURE_MODELS sẽ tự suy về "asset-search".
 */
export const ASSET_SEARCH_TIERS = {
    light: 'asset-search-light',
    standard: 'asset-search',
    heavy: 'asset-search-heavy',
} as const;

export type AiFeature = (typeof AI_FEATURES)[keyof typeof AI_FEATURES];
