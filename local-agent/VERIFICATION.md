# Kết quả sửa recorder Zalo — 20/10/2026

Recorder thu âm theo ứng dụng bằng ScreenCaptureKit, thu micro mặc định bằng
AVCaptureSession và giữ nguyên đường phát âm thanh vật lý. Đã áp dụng cấu hình
Zalo: **Đầu vào âm thanh = Thiết bị mặc định**, **Loa/Tai nghe = Thiết bị mặc định**.
Đã chuyển qua mục cài đặt khác rồi mở lại để xác nhận hai giá trị vẫn được lưu.
Trước khi sửa, riêng Loa/Tai nghe của Zalo vẫn chọn **Multi-Output Device** dù
output macOS đã là tai nghe Bluetooth.

## Mã và vận hành

- `AudioCapture.swift`: thu riêng họ ứng dụng Zalo; ghi PCM theo host clock,
  bù khoảng trống, bỏ mẫu chồng lặp, đóng file bằng `ExtAudioFileDispose`;
  tách hàng đợi điều khiển micro khỏi hàng đợi nhận mẫu.
- `RecordingSupport.swift`: downmix mono/stereo, tách trái/phải, limiter không
  tự tăng gain, chừa headroom AAC, kiểm tra định dạng/thời lượng và giải mã hết
  file trước khi xuất bản. Lỗi ghép giữ lại đầu vào thô.
- `main.swift`: bỏ chuyển Multi-Output theo cuộc gọi; đưa về loa vật lý nếu macOS
  chọn lại đúng UID Multi-Output cũ khi agent nghỉ; trạng thái lỗi/im lặng rõ ràng,
  giữ `answered_at` ở trạng thái chưa xác định, hoàn tất bản ghi khi thoát.
- `run.sh`, `Info.plist`, `.gitignore`: build arm64, chữ ký cục bộ và mô tả quyền,
  giữ binary/cache sinh tự động ngoài Git.
- `tests/`: kiểm thử bằng âm thanh tổng hợp. `README.md`: cách chạy và giới hạn.

Agent cũ PID `27735` đã được dừng khi trạng thái là Idle; đích khôi phục trùng
output Bluetooth tại thời điểm thay thế. Agent bản cuối PID `37792` đang chạy nền
và chờ cuộc gọi. PID là ảnh chụp tại thời điểm kiểm tra, có thể thay đổi khi chạy lại.
Log: `local-agent/.build/agent.log`; PID lưu trong `local-agent/.build/agent.pid`.
Chưa cài dịch vụ tự khởi động khi đăng nhập/reboot.

## Kiểm tra đạt

| Lệnh/kiểm tra | Kết quả |
| --- | --- |
| `BUILD_ONLY=1 bash local-agent/run.sh` | PASS |
| `bash local-agent/tests/run.sh` | ALL LOCAL AGENT REGRESSIONS PASSED |
| Mono/stereo, trái=remote, phải=local, độ dài không bằng nhau | PASS |
| Float đầu vào vượt 0 dBFS, limiter và đỉnh AAC sau giải mã | PASS; peak mẫu thử 0.986871 |
| Phát hiện im lặng, lỗi đầu vào không xuất file cuối/không xóa file thô | PASS |
| PCM có khoảng trống, chồng lặp, preroll và lọc ứng dụng | PASS |
| `bash -n local-agent/run.sh local-agent/tests/run.sh` | PASS |
| `plutil -lint local-agent/Info.plist` | OK |
| `codesign --verify --strict --verbose=2 local-agent/zalo-recorder` | Hợp lệ |
| Kiểm tra whitespace phần mã sửa | PASS |

Các kiểm thử file cần chạy ngoài sandbox vì AVFoundation trong sandbox đã từ
chối chuyển đổi định dạng. Chúng không dùng micro hay cuộc gọi thật.

## Bài thu thử trên máy

Đã chạy `local-agent/zalo-recorder --check-capture` sau khi quyền được cấp.
File tạo thành công:

`~/Movies/ZaloCalls/zalo_20261020T124648_check-a374df42.m4a`

Companion JSON cùng tên. ffprobe xác nhận AAC, stereo, 48 kHz, dài 6.327417 giây
(bao gồm khoảng khởi tạo; phần thu thử chạy 5 giây sau khi khởi động thành công).
Hai nguồn đều nhận được buffer; `capture_error` không có. Cả hai cờ
`remote_non_silent` và `local_non_silent` đều false trong mẫu yên lặng này.
File thô được giữ ở `~/.zalo_recordings_temp/check-a374df42/`.
Kết quả này xác nhận đường thu/ghi file hoạt động, chưa chứng minh thu được lời nói.

Chẩn đoán sau khi chạy agent mới:

- Quyền Microphone: authorized; screen capture preflight: true.
- Output/input vẫn là tai nghe Bluetooth UID `96-D1-7A-EC-76-01`.
- Default output không chọn Multi-Output.
- Accessibility chưa được cấp; tên/hướng cuộc gọi có thể chưa xác định.

## Đối chiếu cuộc gọi thật sau sửa

Người dùng xác nhận **“Đã gọi thử, tiếng rõ”**. Agent tự phát hiện cuộc gọi,
thu và lưu thành công:

`~/Movies/ZaloCalls/zalo_20261020T132305_948b3e50.m4a`

Companion JSON cùng tên có trạng thái `SIGNAL_PRESENT_BOTH_TRACKS`, cả hai cờ
`remote_non_silent` và `local_non_silent` đều true. ffprobe và giải mã toàn file
không báo lỗi: AAC stereo, 48 kHz, dài **26.942583 giây**. Đo trực tiếp trên AAC
đã giải mã: kênh trái peak **-2.410776 dBFS**, RMS **-22.131422 dBFS**; kênh phải
peak **-7.952814 dBFS**, RMS **-30.070577 dBFS**. Không có mẫu NaN/Inf; đỉnh hai
kênh dưới 0 dBFS. Đây là bằng chứng file có tín hiệu ở cả hai kênh; đánh giá tiếng
nghe trực tiếp dựa trên xác nhận của người dùng, không phải từ ngưỡng tín hiệu.

Sau cuộc gọi, thiết bị Bluetooth không còn xuất hiện, input macOS là micro
tích hợp và output đang chọn lại UID Multi-Output cũ. Chưa xác định tác nhân đổi
output. Đã đưa output về `BuiltInSpeakerDevice` khi không có cuộc gọi và bổ sung
kiểm tra lúc idle để xử lý việc chọn lại cấu hình cũ. Giữ nguyên output vật lý
khi đang là loa/tai nghe thông thường; không thay route giữa cuộc gọi.
Sau khi build và kiểm thử lại đạt, đã khởi động lại agent khi không có cuộc gọi;
log bản cuối xác nhận đang chờ cuộc gọi với output `BuiltInSpeakerDevice`.

Chưa chứng minh chính xác nguyên nhân AEC/buffer của sự cố ban đầu hoặc mọi
tổ hợp loa/tai nghe. Accessibility vẫn chưa được cấp; tên/hướng có thể thiếu
hoặc chỉ là tiêu đề chung `Zalo Call`. Bộ phát hiện vẫn dựa trên cửa sổ gọi đang
hiện; thu nhỏ/ẩn cửa sổ có thể kết thúc bản ghi như hành vi detector hiện có.

Toàn bộ `local-agent/` hiện là nội dung chưa được Git theo dõi như trạng thái
ban đầu của thư mục. Chưa commit hoặc push.
