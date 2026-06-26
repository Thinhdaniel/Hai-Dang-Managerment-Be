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
    OCR_INVOICE: 'ocr-invoice', // OCR ảnh hóa đơn mua vật tư -> trích dòng (vision, JSON)
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

/**
 * Model MẶC ĐỊNH theo tác vụ — NHÚNG TRONG CODE (mạnh, hợp túi tiền quota).
 * Mục đích: production luôn có "bộ não" tốt kể cả khi env AI_FEATURE_MODELS thiếu/sai
 * (trước đây thiếu env -> rơi về AI_MODEL_JSON = deepseek nhỏ -> trả lời kém).
 * env AI_FEATURE_MODELS sẽ ĐÈ LÊN bảng này (merge ở env.config) nếu muốn tinh chỉnh.
 *
 * Quy tắc: bước SUY LUẬN/LẬP KẾ HOẠCH của trợ lý phải dùng model mạnh; câu diễn giải/đơn giản dùng model nhanh-rẻ.
 */
export const DEFAULT_FEATURE_MODELS: Record<string, string> = {
    // Trợ lý agentic (lõi suy luận + gọi tool) — dùng biến thể "-agentic" của Kiro (tinh chỉnh cho tool-calling)
    'asset-search-light': 'kr/claude-haiku-4.5-agentic', // câu đơn giản (liệt kê/đếm/tìm/vị trí) — nhanh, rẻ
    'asset-search': 'kr/claude-sonnet-4.5-agentic', // tiêu chuẩn: suy luận + tool-loop mạnh, JSON ổn định
    'asset-search-heavy': 'gc/gemini-2.5-pro', // phân tích/so sánh/lập kế hoạch: model mạnh khác (KHÔNG dùng -thinking vì emit <thinking> phá JSON)
    'asset-answer': 'gc/gemini-2.5-flash', // diễn giải kết quả: nhanh-rẻ
    // Các tác vụ khác
    'material-match': 'kr/claude-haiku-4.5', // khớp tên vật tư (JSON, cần ổn định)
    'supply-request-draft': 'gc/gemini-2.5-flash',
    // Tóm tắt chat trả JSON: dùng Claude Haiku cho JSON ỔN ĐỊNH (như material-match).
    // gc/gemini-2.5-flash thỉnh thoảng trả JSON bẩn/cắt cụt -> parse lỗi -> rơi fallback oan.
    'chat-summary': 'kr/claude-haiku-4.5',
    // OCR hóa đơn giấy: cần model VISION (đọc ảnh). gemini-2.5-flash đọc ảnh + tiếng Việt tốt, rẻ.
    'ocr-invoice': 'gc/gemini-2.5-flash',
    help: 'kr/claude-sonnet-4.5',
    digest: 'gc/gemini-2.5-pro', // bản tin giám đốc: chất lượng cao, chạy ít
    variance: 'kr/claude-haiku-4.5',
};

/** Model mạnh dùng làm lưới cuối khi không resolve được gì (thay cho deepseek nhỏ). */
export const STRONG_FALLBACK_MODEL = 'kr/claude-sonnet-4.5-agentic';
