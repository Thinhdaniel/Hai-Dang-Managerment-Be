# Cấp phát nội bộ và thu hồi: kế hoạch, thay đổi và nghiệm thu

Ngày: 07/09/2026. Phạm vi: vật tư tái sử dụng, không thay đổi nghiệp vụ sản xuất.

## Kế hoạch đã triển khai

1. Bảo vệ chốt phiếu, quyền cơ sở và tính nhất quán giữa phiếu, kho, sổ đang giữ.
2. Hoàn thiện vòng thu hồi, sửa chữa, chuyển hỏng, loại bỏ, cấp lại; lưu lịch sử và giá trị tham chiếu.
3. Sửa tìm kiếm/phân trang, hạn trả trong ngày, thống kê chuyển người giữ và thông báo theo cơ sở.
4. Kiểm thử tự động bằng database tạm; kiểm tra build, lint; nghiệm thu UI và thiết bị thật trước khi phát hành.

## Thay đổi chính

- Thêm dòng và chốt nháp cùng dùng transaction và khóa trạng thái phiếu. Không thể thêm dòng sau khi chốt; quản lý chỉ thao tác phiếu cơ sở mình. Admin và giám đốc giữ quyền toàn hệ thống.
- Khi chốt, lưu các thay đổi người nhận, tổ/chuyền, đợt sử dụng, hạn trả, ghi chú trong cùng transaction với xuất kho và tạo sổ đang giữ. Không âm thầm bỏ qua vật tư đang nhập nhưng chưa thêm vào nháp.
- Vật tư theo từng chiếc không nhận số lẻ. Số lượng theo đơn vị khác tối đa 6 chữ số thập phân. Thu hồi không được trước ngày cấp hoặc ở tương lai.
- Kho thu hồi có thao tác sửa xong, chuyển hỏng, loại bỏ. Mỗi thao tác có người thực hiện, thời gian, số lượng, trạng thái nguồn/đích, lý do và giá trị tham chiếu.
- Giá trị tham chiếu được chuyển theo vật tư thu hồi và cấp lại. Không ghi thêm giao dịch chi phí cấp phát khi cấp lại từ kho thu hồi.
- Tồn cũ chưa có giá trị tham chiếu phải được xác nhận đơn giá trước khi cấp lại hoặc xử lý. Không tự suy đoán giá và không tự sửa lịch sử chi phí. Các lần cấp lại cũ đã lưu đơn giá 0 cần đối soát riêng nếu muốn hiệu chỉnh dữ liệu lịch sử.
- Tổng cấp/đầu kỳ của đợt không cộng thêm các dòng chuyển người giữ. Số nhận chuyển hiển thị riêng, lượng chưa thu vẫn tính từ tất cả dòng trách nhiệm hiện có. Excel thể hiện định nghĩa này.
- Tìm người nhận và đợt sử dụng trên server, tải tiếp danh sách khi cuộn. Danh sách công nhân, đợt mã hàng và sổ đang giữ có phân trang, kể cả trên mobile.
- Hạn trả chọn hôm nay được gửi tới cuối ngày. Thông báo nhắc cả các lần cấp đến hạn trong đợt đang hoạt động, không chỉ đợt đã mở thu hồi.
- Người nhận thông báo: quản lý của cơ sở liên quan, admin và giám đốc. Liên kết mang cơ sở và đợt để mở đúng danh sách; vẫn kiểm tra quyền ở backend.

## Kiểm thử tự động

Chạy tại thư mục backend:

```powershell
npm run test:material-custody
npm run test:material-custody:integration
npm run build
```

- Bộ quy tắc và Excel: 9 test.
- Bộ tích hợp: 12 test trên MongoDB replica set tạm, không dùng URI/database production.
- Bao gồm: thu hồi -> sửa xong -> cấp lại và bảo toàn giá trị; rollback khi cấp lại thất bại; hai yêu cầu thu hồi đồng thời; chặn số lẻ; tách số nhận chuyển; xác nhận giá tồn cũ; quyền khác cơ sở; lưu metadata khi chốt; cạnh tranh thêm dòng/chốt; nhắc hạn đợt đang hoạt động đúng người và chống lặp trong ngày; phân trang vượt 200 công nhân; chặn ngày sai và đợt đã đóng.
- Test tích hợp cần tải MongoDB binary ở lần đầu. `mongodb-memory-server` chỉ là devDependency. Database được đóng và xóa sau test.
- Test thông báo xác nhận nội dung, người nhận và bản ghi trong ứng dụng; không xác nhận Web Push/Telegram đã tới điện thoại thật.

## Nghiệm thu trước khi phát hành

1. Deploy backend trước frontend; không có biến môi trường mới cho tính năng này. Giữ cấu hình push, Telegram và lịch chạy hiện có.
2. Kiểm tra staging ở 390 px và 1440 px: tìm công nhân ngoài trang đầu; sang trang 2 trên mobile; đổi cơ sở; mở modal xử lý kho và lịch sử; kiểm tra tên vật tư dài.
3. Sửa người nhận và hạn trả trên nháp, chốt và đối chiếu phiếu với sổ đang giữ. Thử hai tab đồng thời thêm dòng/chốt, tải lại sau yêu cầu bị từ chối.
4. Thu hồi từng phần theo tốt/cần sửa/hỏng/mất. Sửa xong một phần, cấp lại một phần; đối chiếu tổng đang giữ và từng ngăn kho. Xác nhận chi phí không tăng thêm.
5. Bấm thông báo trong app, Web Push và Telegram: phải về đúng cơ sở/đợt; tài khoản khác cơ sở không được xem dữ liệu đó.
6. Test điện thoại thật với quyền thông báo, app đóng và Telegram đã liên kết. Backend đang ngủ hoặc thiết bị chặn push vẫn có thể chậm giao nhận; không coi lịch cron là bảo đảm thời gian thực tuyệt đối.

Chưa thực hiện trong phiên này: nghiệm thu trực quan qua trình duyệt kết nối và test thông báo trên điện thoại thật. Không sửa/xóa dữ liệu production, không tự commit/push.
