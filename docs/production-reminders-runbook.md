# Nhắc nhập sản lượng theo giờ

## Điều kiện production

- Render phải có `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` và `WEB_PUSH_SUBJECT`.
- Nên có Telegram fallback: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`.
- Phải đặt `INTERNAL_CRON_SECRET` là chuỗi ngẫu nhiên dài, không dùng chung với JWT/API key.
- Mỗi tổ trưởng cần bật Web Push trên điện thoại. iPhone phải cài PWA vào Màn hình chính và mở từ icon.

## UptimeRobot

Mục tiêu là gọi backend mỗi 5 phút để Render free không ngủ đúng lúc cần nhắc.

### Cách ưu tiên

- Monitor type: API Monitoring.
- URL: `https://<backend-domain>/api/internal/production-reminders`.
- Method: `POST`.
- Header: `x-internal-cron-secret: <INTERNAL_CRON_SECRET>`.
- Interval: 5 phút.
- Kỳ vọng: HTTP 200 và JSON có `success: true`.

### Cách dự phòng cho gói không có custom header

- Monitor type: HTTP(s).
- URL: `https://<backend-domain>/api/internal/production-reminders?secret=<INTERNAL_CRON_SECRET>`.
- Method: `GET`.
- Interval: 5 phút.

Query secret có thể xuất hiện trong dashboard/log của dịch vụ monitor. Chỉ dùng HTTPS, giới hạn người xem monitor và đổi `INTERNAL_CRON_SECRET` ngay nếu URL bị chia sẻ hoặc lộ.

## Cách hệ thống quyết định nhắc

1. Chỉ xét ngày sản xuất hôm nay ở múi giờ `Asia/Ho_Chi_Minh` và trạng thái đang nhập.
2. Chỉ xét khung giờ đã kết thúc cộng thời gian chờ.
3. Chỉ xét chuyền đã xác nhận nhân sự và có mã hàng chạy trong khung đó.
4. Nếu còn thiếu, hệ thống cập nhật một thông báo duy nhất của ngày và gửi lại theo chu kỳ. Badge không tăng thêm sau mỗi lần nhắc.
5. Quá mốc escalation, quản lý cơ sở nhận cảnh báo một lần.
6. Khi tất cả chuyền đã báo, sự kiện được đóng. Cảnh báo dưới khoán chỉ gửi sau khi dữ liệu đã đủ.

## Kiểm tra sau deploy

1. Vào `Sản xuất > Nhập theo giờ`, mở cài đặt hình chuông.
2. Kiểm tra mỗi tổ trưởng có ít nhất một kênh `Push` hoặc `Telegram`.
3. Trên điện thoại tổ trưởng, đăng nhập đúng tài khoản, bấm `Bật trên máy này` và giữ nguyên quyền thông báo của hệ điều hành. Chỉ đăng nhập chưa đủ để tạo Web Push subscription.
4. Trên máy quản lý, mở danh sách người nhận và bấm nút gửi thử ở đúng dòng tổ trưởng. Kết quả phải báo số thiết bị Push đã gửi; nếu hiện `Cần bật`, quay lại bước 3 trên chính điện thoại đó.
5. Tạo một ngày thử có khung kết thúc gần hiện tại, để một chuyền chưa nhập và xác nhận thông báo xuất hiện sau thời gian chờ.
6. Nhập bù chuyền đó và xác nhận dải cảnh báo biến mất sau lần đồng bộ tiếp theo.
7. Kiểm tra lịch sử UptimeRobot trả HTTP 200 liên tục.

## Giới hạn nền tảng

- Web Push là thông báo hệ điều hành, không phải báo thức cưỡng bức. Focus/Do Not Disturb, tiết kiệm pin hoặc người dùng tắt quyền có thể trì hoãn hay ẩn thông báo.
- Phản hồi thành công từ push service không chứng minh người dùng đã nhìn thấy thông báo. Telegram fallback chỉ được dùng khi Web Push không gửi được ở tầng server.
- Không nên giảm chu kỳ dưới 5 phút vì trình duyệt/hệ điều hành có thể hạn chế thông báo lặp quá dày.
