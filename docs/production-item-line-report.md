# Báo cáo mã hàng theo tổ

## Luồng sử dụng

1. Vào **Sản xuất > Đơn hàng**, mở đơn cần theo dõi.
2. Tại **Phân giao cho tổ**, nhập tổ, số lượng, ngày bắt đầu và hạn hoàn thành. Tổng giao không vượt tổng đơn; mỗi tổ có một phần giao trong mỗi đơn.
3. Lưu thay đổi kèm lý do. Lịch sử giữ phần giao trước và sau khi sửa.
4. Vào **Báo cáo sản lượng > Mã hàng > Chi tiết từng tổ**. Lọc mã hàng, tổ hoặc tình trạng tiến độ.
5. Mở từng tổ để đối chiếu riêng các đơn hàng, ngày sản xuất và khung giờ. Xuất Excel có thêm hai sheet mã hàng theo tổ và chi tiết ngày giờ.

## Quy tắc số liệu

- Nhóm theo ID mã hàng và ID tổ, không theo tên hiển thị; đổi tên không tách sản lượng thành tổ mới.
- Lũy kế gồm đầu kỳ đã xác định mã hàng và sản lượng ghi nhận đến ngày cuối báo cáo. Phần trước kỳ lọc được hiển thị riêng, không bị mất khi đổi khoảng ngày.
- Số đầu kỳ chưa phân bổ mã hàng không được tự gán vào một mã cụ thể.
- Tổng giao là số lượng của tổ trong hồ sơ đơn hàng. Đây không phải khoán giờ và không phải tổng các dòng kế hoạch ngày.
- Kế hoạch đến hạn chỉ tính các khung giờ đã kết thúc theo giờ Việt Nam. Kế hoạch chưa phát hành không tham gia đối chiếu.
- Sản đối chiếu kế hoạch ngày phải khớp allocation, tổ, mã hàng, đơn hàng, ngày và khung giờ. Sản nhập thủ công vẫn thuộc lũy kế, nhưng không tự được coi là hoàn thành một allocation.
- Phiếu làm bù không cộng nghĩa vụ lần thứ hai. Nguồn làm bù không tìm được hoặc khác tổ/đơn được đánh dấu cần đối chiếu.
- Có nhập 0 là đã báo; chưa nhập là thiếu báo. Kế hoạch đã phát hành nhưng chưa mở ngày sản xuất vẫn xuất hiện.
- Không có phần giao thì phần trăm hoàn thành là trống, không phải 0%. Sản chưa xác định đơn/phần giao không được gán vào đơn cùng mã hàng.
- Làm vượt một đơn không bù phần thiếu của đơn khác: số còn phải làm cộng riêng từng đơn; phần trăm tổng hợp chặn phần đóng góp của từng đơn ở lượng được giao.
- Phạm vi đã khóa sổ chỉ đối chiếu các ngày đã khóa; giữ nguyên giới hạn truy cập theo cơ sở và quyền hiện có.
- Phần giao trong báo cáo quá khứ được dựng lại từ lịch sử thay đổi tính đến cuối ngày báo cáo. Kế hoạch ngày vẫn theo phiên bản đang lưu, không phải bản chụp bất biến toàn hệ thống.

## Triển khai

- Không thêm biến môi trường và không cần migration dữ liệu cũ.
- Deploy backend trước frontend. Dữ liệu cũ chưa phân giao vẫn xem được sản lượng, nhưng cần nhập phần giao để có tỷ lệ hoàn thành.
- Không tự sửa đầu kỳ, đơn hàng hoặc số sản đã nhập khi triển khai.
- Việc phân giao tổng đơn không tự tạo/phát hành kế hoạch ngày. Tiếp tục sử dụng luồng kế hoạch ngày hiện có.
- Kiểm thử: `npm run test:production`, `npm run build` ở backend; `npm run build` ở frontend.
- Script `npx tsx scripts/preview-item-line-report.ts` tạo dữ liệu mẫu local cho giao diện, không kết nối cơ sở dữ liệu.

## Nghiệm thu sau deploy

- Chọn mã có hai tổ cùng sản xuất; tổng các tổ phải bằng tổng mã trong cùng phạm vi lọc.
- Đối chiếu một tổ có đầu kỳ, một tổ không có đầu kỳ và một ngày chưa nhập sản.
- Phân giao hai tổ, kiểm tra phần còn lại và tỷ lệ; sửa một phần giao rồi xem lịch sử.
- Đối chiếu màn hình và hai sheet Excel mới.
- Kiểm tra thêm dữ liệu thật có sản thủ công chưa liên kết kế hoạch trước khi dùng trạng thái tiến độ để đánh giá tổ.
