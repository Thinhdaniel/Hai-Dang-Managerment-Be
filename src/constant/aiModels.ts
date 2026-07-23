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
    MATERIAL_COST_TYPE: 'material-cost-type', // Phân loại bản chất chi phí vật tư/máy (JSON, gán 1 lần)
    MACHINE_TYPE_CODE: 'machine-type-code', // Gợi ý mã viết tắt loại máy + gom loại trùng nghĩa (JSON, chạy ít)
    CHAT_SUMMARY: 'chat-summary', // Tóm tắt hội thoại nội bộ
    OCR_INVOICE: 'ocr-invoice', // OCR ảnh hóa đơn mua vật tư -> trích dòng (vision, JSON)
    OCR_INVOICE_VERIFY: 'ocr-invoice-verify', // Lần đọc 2 độc lập của hóa đơn (model khác dòng) để đối chiếu chéo
    OCR_SUPPLY_REQUEST: 'ocr-supply-request', // OCR ảnh phiếu đề xuất cấp vật tư -> trích dòng (vision, JSON)
    OCR_SUPPLY_REQUEST_VERIFY: 'ocr-supply-request-verify', // Lần đọc 2 độc lập của phiếu đề xuất cấp
    OCR_DISTRIBUTION: 'ocr-distribution', // OCR ảnh phiếu cấp phát nội bộ -> trích dòng CÓ đơn giá/VAT (vision, JSON)
    OCR_DISTRIBUTION_VERIFY: 'ocr-distribution-verify', // Lần đọc 2 độc lập của phiếu cấp phát
    OCR_PURCHASE_RECEIPT: 'ocr-purchase-receipt', // OCR ảnh phiếu giao hàng/nhận hàng NCC -> đối soát đơn đặt (vision, JSON)
    OCR_PURCHASE_RECEIPT_VERIFY: 'ocr-purchase-receipt-verify', // Lần đọc 2 độc lập (model khác dòng) để đối chiếu chéo
    RECEIPT_SEMANTIC_MATCH: 'receipt-semantic-match', // Ghép dòng phiếu NCC vào dòng đơn theo NGỮ NGHĨA (text, JSON)
    OCR_MACHINE_LABEL: 'ocr-machine-label', // OCR ảnh tem thông số máy -> nhãn hiệu/model/serial (vision, JSON)
    PURCHASE_QUOTE_TEXT: 'purchase-quote-text', // Dán tin nhắn báo giá NCC (text) -> trích dòng vật tư
    APPROVAL_REVIEW: 'approval-review', // Rà soát phiếu mua trước khi duyệt (tóm tắt cảnh báo)
    ANALYTICS: 'analytics', // NL -> chart-spec cho AI Analytics Studio (JSON, cần ổn định)
    INCIDENT_REPLAY: 'incident-replay', // Điều tra bất thường vận hành từ timeline/sự kiện thật
    HELP: 'help', // Trợ lý hướng dẫn sử dụng
    EXECUTIVE_BRIEFING: 'executive-briefing', // Bản tin tuần/tháng: diễn giải snapshot có bằng chứng
    VARIANCE: 'variance', // Giải thích biến động chỉ số (câu ngắn, theo nhu cầu)
    AUDIT: 'audit', // Kiểm toán đêm: fallback khi Vertex lỗi (chạy 1 lần/ngày)
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
 * Chiến lược (đảo lại 2026-07-03: `bb/` gần như không còn khả dụng): ưu tiên
 * `kr/` · `gc/` (bền vững lâu dài) làm chuỗi chính, `bb/` lùi xuống làm dự phòng
 * cuối phòng khi `bb/` phục vụ trở lại. env AI_FEATURE_MODELS vẫn ĐÈ LÊN bảng
 * này (string hoặc mảng) nếu muốn tinh chỉnh.
 *
 * Quy tắc: bước SUY LUẬN/LẬP KẾ HOẠCH dùng model mạnh; câu diễn giải/đơn giản dùng model nhanh-rẻ.
 */
export const DEFAULT_FEATURE_MODELS: Record<string, string | string[]> = {
    // Trợ lý máy (tự xuất JSON, không dùng native tool-call nên model nào JSON tốt là được)
    'asset-search-light': ['kr/claude-haiku-4.5-agentic', 'bb/gpt-5.4-nano', 'bb/deepseek-v4-flash'], // câu đơn giản — nhanh, rẻ
    'asset-search': ['kr/claude-sonnet-4.5-agentic', 'bb/claude-sonnet-4.6'], // tiêu chuẩn: suy luận + JSON ổn định
    'asset-search-heavy': ['gc/gemini-2.5-pro', 'bb/gpt-5.5', 'bb/gpt-5.4-pro'], // phân tích/so sánh/lập kế hoạch
    'asset-answer': ['gc/gemini-2.5-flash', 'bb/deepseek-v4-flash', 'bb/gpt-5.4-nano'], // diễn giải kết quả: nhanh-rẻ
    // Các tác vụ khác
    'material-match': ['kr/claude-haiku-4.5', 'bb/claude-sonnet-4.6'], // khớp tên vật tư (JSON, cần ổn định)
    'material-cost-type': ['kr/claude-haiku-4.5', 'bb/claude-sonnet-4.6'], // phân loại chi phí (JSON ổn định)
    'machine-type-code': ['kr/claude-haiku-4.5', 'gc/gemini-2.5-flash', 'bb/claude-sonnet-4.6'], // mã viết tắt loại máy (JSON, ~20 dòng)
    'supply-request-draft': ['gc/gemini-2.5-flash', 'bb/gpt-5.4-nano'],
    'chat-summary': ['kr/claude-haiku-4.5', 'bb/claude-sonnet-4.6'], // JSON ổn định
    // OCR hóa đơn/phiếu: cần model VISION (đọc ảnh). Gemini đọc ảnh + tiếng Việt ổn định nhất ->
    // để ĐẦU chuỗi làm chỗ dựa; bb/gpt-5.4 chỉ là dự phòng nếu Gemini lỗi (cần test lại vision).
    'ocr-invoice': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    'ocr-invoice-verify': ['gc/gemini-2.5-pro', 'kr/claude-sonnet-4.5'],
    'ocr-supply-request': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    'ocr-supply-request-verify': ['gc/gemini-2.5-pro', 'kr/claude-sonnet-4.5'],
    'ocr-distribution': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    'ocr-distribution-verify': ['gc/gemini-2.5-pro', 'bb/gpt-5.5'],
    'ocr-purchase-receipt': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    // Lần đọc 2 dùng model KHÁC DÒNG với lần 1 để lỗi không tương quan (bake-off đã xác nhận bb/gpt-5.5 đọc ảnh tốt)
    'ocr-purchase-receipt-verify': ['gc/gemini-2.5-pro', 'bb/gpt-5.5'],
    'ocr-machine-label': ['gc/gemini-2.5-flash', 'bb/gpt-5.4'],
    'purchase-quote-text': ['kr/claude-haiku-4.5', 'gc/gemini-2.5-flash'], // text thuần, không cần vision
    'approval-review': ['kr/claude-haiku-4.5', 'bb/gpt-5.4'],
    analytics: ['kr/claude-haiku-4.5', 'bb/claude-sonnet-4.6'], // chart-spec JSON từ danh mục cho sẵn
    'incident-replay': ['kr/claude-haiku-4.5', 'gc/gemini-2.5-flash', 'bb/claude-sonnet-4.6'],
    help: ['kr/claude-sonnet-4.5', 'bb/gpt-5.4'],
    'executive-briefing': ['kr/claude-haiku-4.5', 'gc/gemini-2.5-flash', 'bb/claude-sonnet-4.6'],
    variance: ['kr/claude-haiku-4.5', 'bb/deepseek-v4-flash'],
    audit: ['gc/gemini-2.5-pro', 'kr/claude-sonnet-4.5-agentic'], // kiểm toán đêm: dự phòng khi Vertex lỗi
};

/** Model bền vững làm lưới cuối khi không resolve được gì theo tác vụ. */
export const STRONG_FALLBACK_MODEL = 'kr/claude-sonnet-4.5-agentic';
