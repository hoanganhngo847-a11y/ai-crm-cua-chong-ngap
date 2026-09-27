# AI CRM đa kênh cho doanh nghiệp cửa chống ngập

Hệ thống quản lý toàn bộ hành trình khách hàng cho doanh nghiệp sản xuất cửa chống ngập theo đơn đặt hàng. Dự án hợp nhất khách từ Facebook Messenger, Zalo OA, Website, Hotline và quảng cáo vào một hồ sơ trung tâm; AI hỗ trợ các công việc lặp lại để một sale tập trung tư vấn, thương lượng và chốt đơn.

Giai đoạn hiện tại chỉ xây dựng nền tảng và kiến trúc chung. Chưa cấu hình Supabase thật, chưa triển khai đăng nhập và chưa có các chức năng CRM nghiệp vụ.

## Công nghệ hiện tại

- Next.js 16 với App Router.
- React 19.
- TypeScript.
- Tailwind CSS 4.
- ESLint.

## Cài đặt

Yêu cầu máy đã cài Node.js và npm. Tại thư mục dự án, chạy:

```bash
npm install
```

## Chạy môi trường phát triển

```bash
npm run dev
```

Sau đó mở [http://localhost:3000](http://localhost:3000).

## Kiểm tra dự án

```bash
npm run lint
npm run build
```

Dự án hiện chưa có script `typecheck` riêng.

## Quy tắc làm việc

- Không code trực tiếp trên nhánh `main`.
- Làm việc trên đúng branch theo vùng sở hữu, chạy kiểm tra rồi tạo Pull Request để review.
- Không commit khóa bí mật, `.env.local`, dữ liệu khách hàng thật hoặc tệp build.
- Không tự ý sửa vùng code của thành viên khác hoặc contract dùng chung.
- Chưa thêm hướng dẫn Supabase chi tiết vì Supabase chưa được cấu hình.

Trước khi bắt đầu, bắt buộc đọc:

- [Luật tổng dự án](docs/PROJECT_MASTER.md)
- [Quy ước dữ liệu dùng chung](docs/DATA_CONTRACT.md)
