# Runbook UAT và pilot hệ thống Production

## 1. Mục tiêu

Tài liệu này quy định cách chạy song song hệ thống Production với file Excel hiện hành, xử lý sai lệch và quyết định chuyển nguồn dữ liệu chính thức. Không ký nghiệm thu chỉ dựa trên cảm nhận giao diện.

## 2. Phạm vi pilot khuyến nghị

- Một cơ sở, một cán bộ kế hoạch và một nhóm chuyền đại diện.
- Tối thiểu 10 ngày làm việc, tính từ thứ Hai đến thứ Bảy; Chủ Nhật không tính.
- Một file Excel được chỉ định làm nguồn đối chứng trong suốt đợt pilot.
- Dữ liệu tối thiểu: đơn hàng, kế hoạch ngày, sản lượng thực tế, mức sử dụng năng lực, readiness vật tư và dự báo trễ.

## 3. Trách nhiệm

| Vai trò | Trách nhiệm |
| --- | --- |
| Tổ trưởng | Nhập sản lượng đúng khung giờ, kiểm tra dữ liệu chờ đồng bộ trước khi kết thúc ngày |
| QC | Nhập đạt/lỗi và xác minh các trường hợp kiểm vượt sản lượng trong ngày |
| Kế hoạch/Quản lý | Công bố kế hoạch, chụp số hệ thống cuối ngày, nhập số Excel và xử lý sai lệch |
| IT/Quản trị hệ thống | Theo dõi lỗi, backup, restore thử nghiệm và chuẩn bị rollback |
| Giám đốc/Super Admin | Xem bằng chứng, known limitations và ký nghiệm thu cuối cùng |

## 4. Chuẩn bị trước ngày đầu

1. Chốt cơ sở, người tham gia, mã hàng và đơn pilot.
2. Kiểm tra danh mục chuyền, mã hàng, năng suất chuẩn, đơn giá, BOM và tồn vật tư.
3. Chốt tên file Excel, sheet nguồn, giờ khóa số và người sở hữu từng cột.
4. Tạo hồ sơ tại **Production → Pilot & UAT** với ngưỡng sai lệch được phê duyệt.
5. Kiểm tra backup MongoDB gần nhất và ghi người có quyền restore.
6. Bấm **Bắt đầu pilot**. Không thay Excel làm nguồn chính trong ngày đầu.

## 5. Nhịp vận hành hằng ngày

### Trong ngày

- Tổ trưởng nhập sản lượng theo giờ như vận hành thật.
- Kế hoạch chỉ sửa kế hoạch qua luồng có revision/audit; không sửa trực tiếp trong cơ sở dữ liệu.
- Khi có thiếu vật tư hoặc giảm năng lực, cập nhật đúng module để Control Tower dự báo lại.

### Cuối ngày

1. Xác nhận các chuyền đã báo đủ và các bản ghi offline đã đồng bộ.
2. Tại Pilot Center, bấm **Chụp số hôm nay**. Snapshot phải được tạo đúng ngày; không backdate.
3. Mở file Excel nguồn, nhập sáu chỉ số đối chứng mà không nhìn số hệ thống để điều chỉnh Excel.
4. Kiểm tra từng chỉ số lệch và truy nguyên về đơn, kế hoạch, sản lượng, capacity hoặc vật tư.
5. Sửa dữ liệu gốc nếu có bằng chứng. Sau khi sửa, chụp lại snapshot và đối soát lại.
6. Chỉ dùng **Giải trình** khi chênh lệch có nguyên nhân hợp lệ và không thể sửa lịch sử an toàn.

## 6. Định nghĩa chỉ số đối soát

| Chỉ số | Nguồn hệ thống | Quy tắc |
| --- | --- | --- |
| Sản lượng thực tế | Tổng entry ProductionLineRecord trong ngày | Không gồm sản lượng công đoạn phụ |
| Sản lượng kế hoạch | Tổng allocation của kế hoạch đã công bố | Kế hoạch nháp không được tính |
| Đơn đang mở | ProductionOrder chưa hoàn thành/hủy | Trạng thái được đồng bộ từ sản lượng thực tế |
| Sử dụng năng lực | Phút thường đã phân bổ / phút thường khả dụng | Tính trên các chuyền đang hoạt động |
| Đơn chặn vật tư | Readiness thiếu hoặc chỉ đủ một phần | Truy ngược được BOM, tồn, reservation và inbound |
| Dự báo trễ | Forecast completion sau due date | Dùng kế hoạch đã công bố và nhịp sản xuất gần nhất |

## 7. Xử lý sai lệch

1. Kiểm tra cùng cơ sở, cùng ngày và cùng thời điểm chốt.
2. Kiểm tra file Excel có công thức lỗi, lọc ẩn hoặc dòng nhập trùng không.
3. Kiểm tra hệ thống có bản ghi offline chưa đồng bộ, kế hoạch nháp hoặc đơn chưa gắn mã không.
4. Sửa tại nguồn gây sai; không sửa cả hai nguồn để ép khớp.
5. Nếu chấp nhận ngoại lệ, ghi rõ nguyên nhân, người xác minh, phạm vi ảnh hưởng và hành động phòng ngừa.
6. Sai lệch chưa giải trình phải giữ trạng thái đỏ và chặn nghiệm thu.

## 8. Checklist UAT

Thực hiện toàn bộ checklist trong Pilot Center. Mỗi mục cần có bằng chứng cụ thể như mã đơn, ngày test, ảnh chụp, kết quả API hoặc biên bản. Trạng thái `Không áp dụng` chỉ được dùng khi có lý do nghiệp vụ rõ ràng.

Các nhóm bắt buộc gồm:

- Luồng đơn chuẩn, thiếu vật tư, giảm năng lực, đơn khẩn và chia nhiều chuyền.
- Dự báo khi sản lượng thấp liên tiếp và audit khi mở lại kế hoạch.
- Import dữ liệu lớn/có lỗi, phân quyền cơ sở và chỉnh sửa đồng thời.
- Timezone Việt Nam, backup/restore, đào tạo vai trò và diễn tập rollback.

## 9. Backup và diễn tập restore

1. Tạo backup trước khi pilot và ghi thời gian, kích thước, checksum nếu có.
2. Restore vào môi trường thử nghiệm, không restore đè production để kiểm tra.
3. Đối chiếu tối thiểu số user, chuyền, mã hàng, đơn, kế hoạch và sản lượng.
4. Ghi kết quả vào checklist `BACKUP_RESTORE`.
5. Nếu restore chưa được kiểm chứng, pilot không đủ điều kiện ký.

## 10. Rollback

Kích hoạt rollback khi có một trong các điều kiện:

- Mất hoặc nhân đôi dữ liệu sản lượng.
- Sai phạm vi cơ sở hoặc lộ dữ liệu giữa các vai trò.
- Không thể khôi phục vận hành trong thời gian SLA nội bộ.
- Sai lệch nghiêm trọng lặp lại mà chưa xác định được nguyên nhân.

Các bước:

1. Tạm dừng pilot trong hệ thống, không xóa hồ sơ.
2. Thông báo người dùng quay lại file Excel nguồn đã chốt.
3. Xuất và lưu dữ liệu phát sinh trên hệ thống để điều tra.
4. Khóa các thao tác có nguy cơ ghi thêm dữ liệu sai bằng feature flag hoặc quyền truy cập.
5. Sửa lỗi, chạy regression và restore thử nghiệm.
6. Chỉ tiếp tục pilot sau khi người phụ trách nghiệp vụ và IT xác nhận.

## 11. Điều kiện ký nghiệm thu

Hệ thống tự mở gate khi đồng thời đạt:

- Đủ số ngày shadow run đã thiết lập.
- Không còn ngày sai lệch chưa xử lý.
- Toàn bộ checklist bắt buộc đạt hoặc có lý do không áp dụng.
- Không còn known limitation mức nghiêm trọng/cao ở trạng thái mở.

Giám đốc hoặc Super Admin ghi kết luận, phạm vi rollout và ký trên Pilot Center. Sau khi ký, hồ sơ bị khóa để bảo toàn bằng chứng.

## 12. Sau nghiệm thu

- Chuyển nguồn sự thật theo đúng cơ sở/phạm vi đã ghi trong kết luận, không bật đồng loạt tám cơ sở.
- Theo dõi Control Tower hằng ngày trong ít nhất hai tuần đầu.
- Giữ file Excel ở chế độ chỉ đọc trong thời gian chuyển tiếp.
- Mở đợt pilot riêng cho cơ sở tiếp theo; không tái sử dụng hồ sơ đã ký.
