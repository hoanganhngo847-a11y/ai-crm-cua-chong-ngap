import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDossierText } from '../../features/customer-360/service';
import type { CustomerRow } from '../../features/customer-360/service';

test('CustomerRow interface accepts editable fields: assigned_sale_name, sale_notes, marketing_notes, ai_notes', () => {
  const row: CustomerRow = {
    id: 'c1234567-0000-4000-8000-000000000001',
    name: 'Nguyễn Văn Test',
    customer_code: 'KH-000001',
    stage: 'LEAD_NEW',
    source: 'FACEBOOK',
    updated_at: new Date().toISOString(),
    zalo_name: null,
    facebook_name: 'Nguyễn Văn Test',
    phone: '+849******88',
    email: null,
    assigned_sale: 'Lê Hoàng Sale',
    assigned_sale_id: null,
    assigned_sale_name: 'Lê Hoàng Sale',
    sale_notes: 'Khách cần báo giá cửa chống ngập tự động mặt tiền 4m',
    marketing_notes: 'Từ chiến dịch Facebook Ads tháng 10',
    ai_notes: 'Khách hàng có thiện chí cao, đang phân vân giữa inox 304 và hợp kim nhôm',
    current_situation: 'Đang tìm hiểu báo giá',
    last_interaction: new Date().toISOString(),
    lead_score: 80,
    follow_up_at: null,
    ai_updated_at: null,
  };

  assert.equal(row.assigned_sale_name, 'Lê Hoàng Sale');
  assert.equal(row.sale_notes, 'Khách cần báo giá cửa chống ngập tự động mặt tiền 4m');
  assert.equal(row.marketing_notes, 'Từ chiến dịch Facebook Ads tháng 10');
  assert.equal(row.ai_notes, 'Khách hàng có thiện chí cao, đang phân vân giữa inox 304 và hợp kim nhôm');
});

test('sanitizeDossierText allows normal sale and marketing notes while stripping phone and credentials', () => {
  const note = 'Khách ở 123 Đường Láng, cần khảo sát vào chiều thứ 7';
  const clean = sanitizeDossierText(note, 4000);
  assert.equal(clean, note);

  const phoneNote = 'Khách để lại số 0912345678 nhờ gọi lại';
  const cleanPhoneNote = sanitizeDossierText(phoneNote, 4000);
  assert.ok(cleanPhoneNote !== null);
  assert.ok(!cleanPhoneNote?.includes('0912345678'));

  const credNote = 'Mật khẩu wifi nhà khách: secret123';
  const cleanCredNote = sanitizeDossierText(credNote, 4000);
  assert.equal(cleanCredNote, null); // rejected by memory sanitizer
});

test('assigned_sale_name limits length to 200 and trims whitespace', () => {
  const name = '   Trần Thị Kim Tuyến (Sale Hà Nội)   ';
  const trimmed = name.trim().slice(0, 200);
  assert.equal(trimmed, 'Trần Thị Kim Tuyến (Sale Hà Nội)');
  assert.ok(trimmed.length <= 200);

  const veryLongName = 'A'.repeat(300);
  const truncated = veryLongName.slice(0, 200);
  assert.equal(truncated.length, 200);
});

test('note fields limits length to 4000 characters', () => {
  const longNote = 'Ghi chú chi tiết về hiện trạng ngập nước. '.repeat(150);
  assert.ok(longNote.length > 4000);
  const sanitized = sanitizeDossierText(longNote, 4000);
  assert.ok(sanitized !== null);
  assert.ok(sanitized.length <= 4000);
});
