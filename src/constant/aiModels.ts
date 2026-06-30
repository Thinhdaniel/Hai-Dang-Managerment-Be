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
    OCR_SUPPLY_REQUEST: 'ocr-supply-request', // OCR ảnh phiếu đề xuất cấp vật tư -> trích dòng (vision, JSON)
    APPROVAL_REVIEW: 'approval-review', // Rà soát phiếu mua trước khi duyệt (tóm tắt cảnh báo)
    ANALYTICS: 'analytics', // NL -> chart-spec cho AI Analytics Studio (JSON, cần ổn định)
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
 * Model MẶC ĐỊNH theo tác vụ — NHÚNG TRONG CODE. Mỗi tác vụ là 1 CHUỖI DỰ PHÒNG
 * (ưu tiên giảm dần): gọi model đầu, lỗi/không khả dụng thì tự rớt sang model sau.
 *
 * Chiến lược: ưu tiên các model `bb/` (mạnh, đang khả dụng) rồi rớt về `kr/` · `gc/`
 * (bền vững lâu dài) để khi `bb/` ngừng phục vụ trong tương lai hệ thống vẫn chạy.
 * env AI_FEATURE_MODELS vẫn ĐÈ LÊN bảng này (string hoặc mảng) nếu muốn tinh chỉnh.
 *
 * Quy tắc: bước SUY LUẬN/LẬP KẾ HOẠCH dùng model mạnh; câu diễn giải/đơn giản dùng model nhanh-rẻ.
 */
export const DEFAULT_FEATURE_MODELS: Record<string, string | string[]> = {
    // Trợ lý máy (tự xuất JSON, không dùng native tool-call nên model nào JSON tốt là được)
    'asset-search-light': ['bb/gpt-5.4-nano', 'bb/deepseek-v4-flash', 'kr/claude-haiku-4.5-agentic'], // câu đơn giản — nhanh, rẻ
    'asset-search': ['bb/claude-sonnet-4.6', 'kr/claude-sonnet-4.5-agentic'], // tiêu chuẩn: suy luận + JSON ổn định
    'asset-search-heavy': ['bb/gpt-5.5', 'bb/gpt-5.4-pro', 'gc/gemini-2.5-pro'], // phân tích/so sánh/lập kế hoạch
    'asset-answer': ['bb/deepseek-v4-flash', 'bb/gpt-5.4-nano', 'gc/gemini-2.5-flash'], // diễn giải kết quả: nhanh-rẻ
    // Các tác vụ khác
    'material-match': ['bb/claude-sonnet-4.6', 'kr/claude-haiku-4.5'], // khớp tên vật tư (JSON, cần ổn định)
    'supply-request-draft': ['bb/gpt-5.4-nano', 'gc/gemini-2.5-flash'],
    'chat-summary': ['bb/claude-sonnet-4.6', 'kr/claude-haiku-4.5'], // JSON ổn định
    // OCR hóa đơn/phiếu: cần model VISION (đọc ảnh). Gemini đọc ảnh + tiếng Việt ổn định nhất ->
    // để ĐẦU chuỗi làm chỗ dựa; bb/gpt-5.4 chỉ là dự phòng nếu Gemini lỗi (cần test lại vision).
    'ocr-invoice': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    'ocr-supply-request': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    'approval-review': ['bb/gpt-5.4', 'kr/claude-haiku-4.5'],
    analytics: ['bb/claude-sonnet-4.6', 'kr/claude-haiku-4.5'], // chart-spec JSON từ danh mục cho sẵn
    help: ['bb/gpt-5.4', 'kr/claude-sonnet-4.5'],
    digest: ['bb/gpt-5.5', 'gc/gemini-2.5-pro'], // bản tin giám đốc: chất lượng cao, chạy ít
    variance: ['bb/deepseek-v4-flash', 'kr/claude-haiku-4.5'],
};

/** Model bền vững làm lưới cuối khi không resolve được gì theo tác vụ. */
export const STRONG_FALLBACK_MODEL = 'kr/claude-sonnet-4.5-agentic';
