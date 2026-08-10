import { USER_ROLE } from './allowedRoles';

/**
 * Nhóm role dùng chung cho toàn bộ route (một nguồn sự thật cho phân quyền).
 * - ADMIN_ONLY : chỉ Super Admin — quản trị hệ thống, xoá dữ liệu gốc, tem QR.
 * - DIRECTOR_UP: Super Admin + Giám đốc — giám sát, duyệt, xem người dùng.
 * - MANAGEMENT : Super Admin + Giám đốc + Quản lý — toàn bộ thao tác vận hành.
 * - FIELD      : tất cả role hiện trường (gồm Bộ phận kỹ thuật) — nghiệp vụ máy qua QR.
 *               KHÔNG gồm Tổ trưởng: tổ trưởng không đụng module máy/vật tư.
 * - PRODUCTION_FIELD: FIELD + Tổ trưởng + QC — lớp đọc chung của app sản xuất.
 * - PRODUCTION_ENTRY: các role được nhập/chỉnh sản lượng và cấu hình đầu ngày.
 * - PRODUCTION_QC_ENTRY: các role được nhập/chỉnh kết quả QC theo giờ.
 * - PRODUCTION_QC_REPORT: các role được xem báo cáo QC theo phạm vi cơ sở.
 */
export const ROLE_GROUPS = {
    ADMIN_ONLY: [USER_ROLE.ADMIN],
    DIRECTOR_UP: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR],
    MANAGEMENT: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER],
    FIELD: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER, USER_ROLE.STAFF],
    PRODUCTION_FIELD: [
        USER_ROLE.ADMIN,
        USER_ROLE.DIRECTOR,
        USER_ROLE.MANAGER,
        USER_ROLE.STAFF,
        USER_ROLE.LINE_LEADER,
        USER_ROLE.QC,
    ],
    PRODUCTION_ENTRY: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER, USER_ROLE.STAFF, USER_ROLE.LINE_LEADER],
    PRODUCTION_QC_ENTRY: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER, USER_ROLE.QC],
    PRODUCTION_QC_REPORT: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER, USER_ROLE.QC],
} as const;
