import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processFacebookInboundPhonePrivacy } from '../../features/omnichannel/facebook/phone-intake';
import { sanitizePhoneInText } from '../../features/crm/utils/phone-sanitizer';

test('valid Vietnamese phone is stored privately and hidden from sale chat', () => {
  const result = processFacebookInboundPhonePrivacy('SĐT của tôi 0912345678 nhé');
  assert.equal(result.status, 'VALID');
  assert.equal(result.phone, '+84912345678');
  assert.equal(result.safeStatus, 'SUCCEEDED');
  assert.ok(result.safeContent?.includes('[số điện thoại đã ẩn]'));
  assert.ok(!result.safeContent?.includes('0912345678'));
});

test('invalid phone-like number stays visible and gets a retry note', () => {
  for (const input of ['SĐT: 09123', 'SĐT: 0312345678']) {
    const result = processFacebookInboundPhonePrivacy(input);
    assert.equal(result.status, 'INVALID');
    assert.equal(result.phone, null);
    assert.ok(result.safeContent?.includes(input.split(':').pop()!.trim()));
    assert.ok(result.safeContent?.includes('chưa hợp lệ'));
  }
});

test('dates, prices and technical numbers are preserved', () => {
  const input = 'Hẹn 07/10/2026, giá 9500000 đ, cửa rộng 2.5m';
  const result = processFacebookInboundPhonePrivacy(input);
  assert.equal(result.status, 'NONE');
  assert.equal(result.phone, null);
  assert.ok(result.safeContent?.includes('07/10/2026'));
  assert.ok(result.safeContent?.includes('9500000'));
  assert.ok(result.safeContent?.includes('2.5m'));
});

test('multiple valid phones are hidden but not auto-selected', () => {
  const result = processFacebookInboundPhonePrivacy('Gọi 0912345678 hoặc 0988123456');
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.phone, null);
  assert.ok(!result.safeContent?.includes('0912345678'));
  assert.ok(!result.safeContent?.includes('0988123456'));
  assert.ok(result.safeContent?.includes('nhiều số điện thoại'));
});

test('sale sanitizer preserves invalid candidates but masks valid ones', () => {
  assert.equal(sanitizePhoneInText('SĐT 09123'), 'SĐT 09123');
  assert.equal(sanitizePhoneInText('SĐT 0312345678'), 'SĐT 0312345678');
  assert.equal(sanitizePhoneInText('SĐT 0912345678'), 'SĐT 09******78');
});
