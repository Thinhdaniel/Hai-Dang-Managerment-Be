export const AUTH_MESSAGES = {
    LOGIN_SUCCESS: 'Đăng nhập thành công',
    LOGIN_FAILED: 'Email hoặc mật khẩu không chính xác',
    TOKEN_INVALID: 'Token không hợp lệ',
    TOKEN_EXPIRED: 'Token đã hết hạn',
    TOKEN_VALIDATION_FAILED: 'Xác thực token thất bại',
    USER_NOT_FOUND: 'Người dùng không tồn tại',
    USER_NOT_ACTIVE: 'Tài khoản của bạn chưa được kích hoạt',
    USER_BANNED: (reason?: string, time?: string) =>
        `Tài khoản của bạn đã bị khóa! Lý do: ${reason || 'Không xác định'}. Thời gian khóa: ${time || 'Không xác định'}. Vui lòng liên hệ hỗ trợ.`,
    AUTH_ERROR: 'Có lỗi xảy ra khi xác thực người dùng',
    REGISTER_SUCCESS: 'Đăng ký tài khoản thành công',
    USER_ALREADY_EXISTS: 'Tài khoản hoặc email đã tồn tại',
};

export const ACCESS_MESSAGES = {
    PERMISSION_DENIED: 'Bạn không có quyền thực hiện hành động này',
    UNAUTHORIZED: 'Vui lòng đăng nhập để tiếp tục',
};

export const UPLOAD_MESSAGES = {
    INVALID_FILE_TYPE: 'Chỉ chấp nhận những file có đuôi là JPG, JPEG, PNG, WEBP hoặc AVIF!',
    FILE_TOO_LARGE: 'Kích thước file quá lớn',
};

export const SYSTEM_MESSAGES = {
    ROUTE_NOT_FOUND: 'Đường dẫn này không tồn tại',
    CORS_ERROR: 'Không được phép truy cập bởi chính sách CORS',
    INTERNAL_SERVER_ERROR: 'Lỗi hệ thống, vui lòng thử lại sau',
};

export const VALIDATION_MESSAGES = {
    FIELD_REQUIRED: (field: string) => `${field} là bắt buộc`,
    JWT_ACCESS_TOKEN_REQUIRED: 'JWT Access Token Key là bắt buộc',
    JWT_VERIFY_TOKEN_REQUIRED: 'JWT Verify Token Key là bắt buộc',
};

export const COMMON_MESSAGES = {
    SUCCESS: 'Thao tác thực hiện thành công',
};
