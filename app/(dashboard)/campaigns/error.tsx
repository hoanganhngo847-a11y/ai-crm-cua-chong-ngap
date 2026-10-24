"use client";
import { Button } from "../../../components/ui/button";
export default function CampaignError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="space-y-4 p-6">
      <h2>Không tải được chiến dịch</h2>
      <p>Kiểm tra quyền truy cập và kết nối rồi thử lại.</p>
      <Button onClick={reset}>Thử lại</Button>
    </div>
  );
}
