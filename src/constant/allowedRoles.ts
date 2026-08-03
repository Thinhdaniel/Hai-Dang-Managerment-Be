export enum USER_ROLE {
    ADMIN = 'admin',
    MANAGER = 'manager',
    STAFF = 'staff',
    DIRECTOR = 'director',
    // Tổ trưởng chuyền: chỉ báo sản lượng theo giờ, không đụng module máy/vật tư.
    LINE_LEADER = 'line_leader',
    // QC: chỉ kiểm tra đạt/lỗi theo giờ tại cơ sở được phân công.
    QC = 'qc',
}
