# Công nhân tự đổi mật khẩu

## Phạm vi

- Chỉ role `worker`; các role khác chưa được mở chức năng này.
- Trên frontend: **Sổ của tôi → Tài khoản → Đổi mật khẩu**.
- Không thay đổi tên đăng nhập, thông tin cá nhân hoặc dữ liệu sổ công nhân.
- Admin vẫn có thể đặt lại mật khẩu qua chức năng quản lý tài khoản hiện có, nhưng không xem được mật khẩu do công nhân tự đặt.

## API

`POST /api/auth/change-password` (cũng hỗ trợ `/api/v1/auth/change-password`).

Yêu cầu Bearer access token của tài khoản công nhân đang hoạt động và body gồm:

```json
{
    "currentPassword": "original-password",
    "newPassword": "a-new-private-password",
    "confirmPassword": "a-new-private-password"
}
```

- Mật khẩu mới tối thiểu 8 ký tự, tối đa 72 byte UTF-8 do giới hạn bcrypt; không tự cắt hoặc trim mật khẩu.
- Phải khác mật khẩu hiện tại và khớp xác nhận.
- Tài khoản đích lấy từ phiên đã xác thực, không chấp nhận `userId` hoặc `role` do client gửi.
- Tối đa 5 lần thất bại trong 15 phút cho mỗi tài khoản, dùng chung bộ đếm giữa các phiên. Thành công không tính vào giới hạn; công nhân cùng mạng không chặn lẫn nhau.
- Lưu bcrypt hash, xóa token đặt lại mật khẩu cũ và thu hồi các phiên cũ. Cập nhật có điều kiện để hai yêu cầu đồng thời dùng mật khẩu cũ không cùng thành công.
- Trả `{ user, access_token }` đã loại bỏ trường mật khẩu; refresh token mới nằm trong cookie HttpOnly. Frontend cập nhật phiên ngay, không xóa sổ hoặc dữ liệu đang nhập.

Mã lỗi: `400` dữ liệu hoặc mật khẩu hiện tại không hợp lệ, `401` phiên không hợp lệ, `403` role khác, `429` vượt giới hạn.

## Kiểm tra và triển khai

- `npm run test:worker-password`: kiểm thử HTTP với MongoDB tạm, không dùng dữ liệu sản xuất.
- `npx tsx --test src/routes/__tests__/worker-notebook.http.test.ts`: kiểm tra lại sổ công nhân và admin đặt lại mật khẩu.
- Triển khai backend và frontend cùng đợt. Không cần migration vì dùng các trường mật khẩu và phiên có sẵn.
- Không log body của API này; không lưu hoặc trả lại mật khẩu thô.
