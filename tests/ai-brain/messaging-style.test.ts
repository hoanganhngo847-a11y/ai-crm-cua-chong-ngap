import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADULT_BIRTH_YEAR_CUTOFF,
  analyzeCustomerMessaging,
  applyContactRequestPolicy,
  buildMessengerFallbackReply,
  buildMessengerPhoneReceivedReply,
  containsPhoneRequest,
  formatMessagingPolicy,
  messageContainsCustomerPhone,
  messageIsOnlyContactInfo,
  stripPhoneRequest,
} from '../../features/ai-brain/messaging-style';

function inbound(content: string) {
  return { direction: 'INBOUND' as const, actorType: 'CUSTOMER', content };
}

function outbound(content: string) {
  return { direction: 'OUTBOUND' as const, actorType: 'AI', content };
}

test('Messaging Style: parent asking for a child uses em/anh-chị', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Tìn hiểu cho con'),
      outbound('Dạ em hỏi thêm năm sinh và nơi ở của bé ạ.'),
      inbound('Sinh năm 98, ở miền bắc'),
    ],
  });

  assert.equal(profile.persona, 'PARENT');
  assert.equal(profile.selfReference, 'em');
  assert.equal(profile.customerAddress, 'anh/chị');
  assert.equal(profile.birthYear, 1998);
  assert.equal(profile.locationKnown, true);
  assert.equal(profile.customerTurnCount, 2);
  assert.equal(profile.contactRequestAllowed, false);
});

test('Messaging Style: student asking for themselves uses ad/em', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Mình cần tư vấn cho bản thân ạ'),
      inbound('2k2, có bằng cử nhân'),
      inbound('Hà Nội'),
    ],
  });

  assert.equal(profile.persona, 'STUDENT');
  assert.equal(profile.selfReference, 'ad');
  assert.equal(profile.customerAddress, 'em');
  assert.equal(profile.birthYear, 2002);
  assert.equal(profile.contactRequestAllowed, true);
});

test('Messaging Style: adult asking for themselves uses em/anh-chị', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Mình cần tư vấn cho bản thân'),
      inbound('Sinh năm 1985'),
      inbound('Cần Thơ'),
    ],
  });

  assert.equal(profile.persona, 'ADULT');
  assert.equal(profile.selfReference, 'em');
  assert.equal(profile.customerAddress, 'anh/chị');
  assert.equal(profile.birthYear, 1985);
});

test('Messaging Style: birth-year cutoff is 2000 for self inquiries', () => {
  assert.equal(ADULT_BIRTH_YEAR_CUTOFF, 2000);

  const born2000 = analyzeCustomerMessaging({
    latestText: 'Mình sinh năm 2000, ở Hà Nội, tư vấn cho mình',
  });
  assert.equal(born2000.persona, 'ADULT');
  assert.equal(born2000.selfReference, 'em');

  const born2001 = analyzeCustomerMessaging({
    latestText: 'Mình sinh năm 2001, ở Hà Nội, tư vấn cho mình',
  });
  assert.equal(born2001.persona, 'STUDENT');
  assert.equal(born2001.selfReference, 'ad');
});

test('Messaging Style: unknown customer defaults to em/anh-chị and cannot be asked for a phone', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Tư vấn du học Đức' });

  assert.equal(profile.persona, 'UNKNOWN');
  assert.equal(profile.selfReference, 'em');
  assert.equal(profile.customerAddress, 'anh/chị');
  assert.equal(profile.contactRequestAllowed, false);
  assert.deepEqual(profile.missingDiscoveryFields, ['relationship', 'birthYear', 'location']);
});

test('Messaging Style: phone already provided disables further phone requests', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Mình cần tư vấn cho bản thân'),
      inbound('Sinh năm 1998'),
      inbound('Hà Nội'),
      inbound('Sđt 0912345678'),
    ],
  });

  assert.equal(profile.phoneProvided, true);
  assert.equal(profile.contactRequestAllowed, false);
});

test('Messaging Style: detects phone numbers and contact-only messages', () => {
  assert.equal(messageContainsCustomerPhone('[số điện thoại đã ẩn]'), true);
  assert.equal(messageContainsCustomerPhone('Sđt của mình là 0912345678 nhé'), true);
  assert.equal(messageContainsCustomerPhone('0988 123 456'), true);
  assert.equal(messageContainsCustomerPhone('Học phí bên mình bao nhiêu?'), false);

  assert.equal(messageIsOnlyContactInfo('Dạ sđt của em là [số điện thoại đã ẩn] ạ'), true);
  assert.equal(messageIsOnlyContactInfo('0912345678'), true);
  assert.equal(
    messageIsOnlyContactInfo('SĐT 0912345678, cho mình hỏi học phí bao nhiêu ạ?'),
    false,
  );
});

test('Messaging Style: strips a phone request while preserving an answer', () => {
  const answerWithRequest =
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1. Anh/chị cho em xin sđt nhé.';
  assert.equal(containsPhoneRequest(answerWithRequest), true);
  assert.equal(
    stripPhoneRequest(answerWithRequest),
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
  );

  const fillerWithRequest =
    'Dạ, để em hỗ trợ tư vấn chi tiết về điều kiện, anh/chị cho em xin số điện thoại liên hệ nhé ạ!';
  assert.equal(stripPhoneRequest(fillerWithRequest), '');

  // A short but concrete answer survives even when the phone request is removed.
  assert.equal(
    stripPhoneRequest('Học phí 20 triệu. Anh/chị cho em xin sđt nhé.'),
    'Học phí 20 triệu.',
  );
});

test('Messaging Style: applies the contact policy to drafts', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Điều kiện du học Đức thế nào?' });

  assert.equal(
    applyContactRequestPolicy(
      'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1. Anh/chị cho em xin sđt nhé.',
      profile,
    ),
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
  );

  assert.equal(
    applyContactRequestPolicy(
      'Dạ, để em hỗ trợ tư vấn chi tiết về điều kiện, anh/chị cho em xin số điện thoại liên hệ nhé ạ!',
      profile,
    ),
    buildMessengerFallbackReply(profile),
  );
});

test('Messaging Style: builds persona-aware fallbacks', () => {
  const student = analyzeCustomerMessaging({
    latestText: 'Em là sinh viên, tư vấn cho em ạ',
  });
  assert.match(buildMessengerFallbackReply(student), /^Dạ ad/);
  assert.match(buildMessengerPhoneReceivedReply(student), /^Dạ ad/);

  const parent = analyzeCustomerMessaging({ latestText: 'Tìm hiểu cho con' });
  assert.match(buildMessengerFallbackReply(parent), /^Dạ em/);
  assert.match(buildMessengerPhoneReceivedReply(parent), /^Dạ em/);
});

test('Messaging Style: formats the prompt policy block', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Tìm hiểu cho con' });
  const block = formatMessagingPolicy(profile);

  assert.match(block, /\[CUSTOMER PERSONA & CONTACT POLICY\]/);
  assert.match(block, /PHỤ HUYNH HỎI CHO CON\/CHÁU/);
  assert.match(block, /AI xưng "em", gọi khách "anh\/chị"/);
  assert.match(block, /Được phép xin số điện thoại ở lượt này: KHÔNG/);
});
