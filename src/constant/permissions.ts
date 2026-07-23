import { USER_ROLE } from './allowedRoles';

/**
 * Nhóm role dùng chung cho toàn bộ route (một nguồn sự thật cho phân quyền).
 * - ADMIN_ONLY : chỉ Super Admin — quản trị hệ thống, xoá dữ liệu gốc, tem QR.
 * - DIRECTOR_UP: Super Admin + Giám đốc — giám sát, duyệt, xem người dùng.
 * - MANAGEMENT : Super Admin + Giám đốc + Quản lý — toàn bộ thao tác vận hành.
 * - FIELD      : tất cả role hiện trường (gồm Bộ phận kỹ thuật) — nghiệp vụ máy qua QR.
 *               KHÔNG gồm Tổ trưởng: tổ trưởng không đụng module máy/vật tư.
 * - PRODUCTION_FIELD: FIELD + Tổ trưởng — chỉ dùng cho lớp base của route sản lượng,
 *               để tổ trưởng nhập được số theo giờ mà các module khác vẫn chặn.
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
    ],
} as const;
